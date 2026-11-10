"""The GitHub transport: REST and GraphQL over the standard library.

Everything that talks to GitHub takes ``rest=`` and/or ``graphql=`` callables,
so tests (and other transports, such as the ``gh`` CLI) can stand in. The
defaults built here use :mod:`urllib` and a token from the environment, which
is what a GitHub Action provides, so the collector needs no dependency.

Token resolution order (first non-empty wins): the ``token`` argument,
``GHTRAFFIC_TOKEN``, ``GH_TOKEN``, ``GITHUB_TOKEN``, then ``gh auth token``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

Rest = Callable[[str], Any]
GraphQL = Callable[[str, Mapping[str, Any]], dict]

DFLT_API_URL = "https://api.github.com"
TOKEN_ENV_VARS = ("GHTRAFFIC_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")
DFLT_TIMEOUT = 30
DFLT_RETRIES = 4
DFLT_BACKOFF_S = 2.0
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
#: Longest wait for a primary rate-limit reset before giving up on a call.
MAX_RATE_LIMIT_WAIT_S = 120.0
_POLICY_MARKERS = (
    "saml",
    "sso",
    "personal access token",
    "oauth app access restrictions",
    "forbids access",
)


class GitHubError(RuntimeError):
    """A GitHub API call that failed, with its HTTP status (0 for network errors)."""

    def __init__(self, status: int, message: str, *, path: str = ""):
        super().__init__(f"GitHub {status} on {path}: {message}")
        self.status = status
        self.message = message
        self.path = path

    @property
    def is_rate_limit(self) -> bool:
        """Whether this is a (primary or secondary) rate-limit refusal."""
        return self.status == 429 or (
            self.status == 403 and "rate limit" in self.message.lower()
        )

    @property
    def is_policy_block(self) -> bool:
        """Whether an org policy (SAML SSO, token-type restriction) refused the call.

        These are not "no push access": the token could read the repo if the
        org allowed it, so they are reported as errors, never silently skipped.
        """
        msg = self.message.lower()
        return self.status == 403 and any(s in msg for s in _POLICY_MARKERS)


def resolve_token(token: str | None = None) -> str:
    """Find a GitHub token, or raise with instructions on how to provide one."""
    if token:
        return token
    for var in TOKEN_ENV_VARS:
        if os.environ.get(var):
            return os.environ[var]
    if shutil.which("gh"):
        proc = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True)
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    raise RuntimeError(
        "No GitHub token found. Set GHTRAFFIC_TOKEN (or GH_TOKEN / GITHUB_TOKEN), "
        "or log in with the GitHub CLI (`gh auth login`). Traffic endpoints need "
        "push access to each repo: a classic token with the `repo` and `read:org` "
        "scopes covers every owner you can push to."
    )


def _retry_wait(headers, fallback: float) -> float:
    """Seconds to wait: ``Retry-After``, else the rate-limit reset, else ``fallback``."""
    if headers.get("Retry-After"):
        return float(headers["Retry-After"])
    if headers.get("x-ratelimit-remaining") == "0" and headers.get("x-ratelimit-reset"):
        return max(1.0, float(headers["x-ratelimit-reset"]) - time.time())
    return fallback


def _request(
    method: str,
    url: str,
    *,
    token: str,
    body: bytes | None = None,
    timeout: float,
    retries: int,
    backoff_s: float,
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ghtraffic",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    path = url.removeprefix(DFLT_API_URL)
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")
            try:
                msg = json.loads(msg).get("message", msg)
            except (ValueError, AttributeError):
                pass
            err = GitHubError(e.code, msg, path=path)
            retryable = e.code in _RETRY_STATUSES or err.is_rate_limit
            if not retryable or attempt == retries:
                raise err from None
            wait = _retry_wait(e.headers, backoff_s * 2**attempt)
            if wait > MAX_RATE_LIMIT_WAIT_S:
                raise err from None  # the quota resets too late for this run
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries:
                raise GitHubError(0, str(e), path=path) from None
            wait = backoff_s * 2**attempt
        sleep(wait)
    raise AssertionError("unreachable")  # pragma: no cover


def make_rest(
    token: str | None = None,
    *,
    api_url: str = DFLT_API_URL,
    timeout: float = DFLT_TIMEOUT,
    retries: int = DFLT_RETRIES,
    backoff_s: float = DFLT_BACKOFF_S,
) -> Rest:
    """A ``rest(path) -> json`` callable for GET requests (``path`` like ``/user``)."""
    tok = resolve_token(token)

    def rest(path: str) -> Any:
        return _request(
            "GET",
            f"{api_url}{path}",
            token=tok,
            timeout=timeout,
            retries=retries,
            backoff_s=backoff_s,
        )

    return rest


def make_graphql(
    token: str | None = None,
    *,
    api_url: str = DFLT_API_URL,
    timeout: float = DFLT_TIMEOUT,
    retries: int = DFLT_RETRIES,
    backoff_s: float = DFLT_BACKOFF_S,
) -> GraphQL:
    """A ``graphql(query, variables) -> data`` callable."""
    tok = resolve_token(token)

    def graphql(query: str, variables: Mapping[str, Any]) -> dict:
        body = json.dumps({"query": query, "variables": dict(variables)}).encode()
        payload = _request(
            "POST",
            f"{api_url}/graphql",
            token=tok,
            body=body,
            timeout=timeout,
            retries=retries,
            backoff_s=backoff_s,
        )
        errors = (payload or {}).get("errors")
        if errors:  # partial data hides repos (SSO, restrictions): never drop it
            limited = any(e.get("type") == "RATE_LIMITED" for e in errors)
            messages = "; ".join(str(e.get("message", e)) for e in errors)
            raise GitHubError(429 if limited else 200, messages, path="/graphql")
        return payload["data"]

    return graphql
