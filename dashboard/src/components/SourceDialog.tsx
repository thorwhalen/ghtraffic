/**
 * Where the data comes from: the public demo / a data URL, or a private GitHub
 * repository read with a token.
 *
 * The form keeps its own draft (typing is not the value); "Load" commits it
 * through store.applySource, which saves settings via the zodal store, puts the
 * repo coordinates (never the token) in the URL hash, and reloads.
 */
import { useEffect, useState } from "react";
import { isValidRepo } from "../sources";
import { useStore } from "../store";
import { Sheet } from "./ui";

const TOKEN_HELP_URL =
  "https://github.com/settings/personal-access-tokens/new";

export function SourceDialog() {
  const open = useStore((s) => s.sourceOpen);
  const setOpen = useStore((s) => s.setSourceOpen);
  const settings = useStore((s) => s.settings);
  const load = useStore((s) => s.load);
  const route = useStore((s) => s.route);
  const applySource = useStore((s) => s.applySource);
  const forgetToken = useStore((s) => s.forgetToken);

  // The draft: seeded from settings (and the hash's repo) each time the sheet opens.
  const [draft, setDraft] = useState(settings);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    if (!open) return;
    const fromHash = route.dataRepo;
    setDraft({
      ...settings,
      ...(fromHash ? { source: "github" as const, ghRepo: fromHash.repo, ghBranch: fromHash.branch ?? "main", ghPath: fromHash.path ?? "" } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Local flag set in the click handler itself, so the button turns pending in
  // the same frame (before the settings write and the fetches start).
  const [busy, setBusy] = useState(false);
  const pending = busy || load.status === "loading";
  const repoOk = draft.source !== "github" || isValidRepo(draft.ghRepo.trim());
  const showError = load.status === "error" && load.error;

  const submit = async () => {
    if (pending || !repoOk) return;
    setBusy(true);
    const patch = { ...draft, ghRepo: draft.ghRepo.trim(), ghBranch: draft.ghBranch.trim() || "main", ghPath: draft.ghPath.trim().replace(/^\/+|\/+$/g, ""), url: draft.url.trim() };
    try {
      await applySource(patch);
    } finally {
      setBusy(false);
    }
    if (useStore.getState().load.status === "ready") setOpen(false);
  };

  return (
    <Sheet
      open={open}
      onClose={() => setOpen(false)}
      title="Data source"
      footer={
        <>
          <button type="button" className="link-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-btn"
            aria-busy={pending}
            aria-disabled={pending || !repoOk}
            data-pending={pending || undefined}
            onClick={submit}
          >
            {pending ? `Loading${load.progress ? ` ${load.progress[0]}/${load.progress[1]}` : "…"}` : "Load"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend>Source</legend>
          <label className="radio">
            <input type="radio" name="source" checked={draft.source === "url"} onChange={() => setDraft({ ...draft, source: "url" })} />
            Demo or a public data URL
          </label>
          <label className="radio">
            <input type="radio" name="source" checked={draft.source === "github"} onChange={() => setDraft({ ...draft, source: "github" })} />
            Private GitHub repository
          </label>
        </fieldset>

        {draft.source === "url" ? (
          <fieldset>
            <label className="field">
              Data URL
              <input type="url" inputMode="url" placeholder="Empty = synthetic demo" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
            </label>
            <p className="hint">A folder holding manifest.json, served over HTTPS with CORS. Fetched without credentials.</p>
          </fieldset>
        ) : (
          <fieldset>
            <label className="field">
              Repository
              <input
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="owner/name"
                value={draft.ghRepo}
                aria-invalid={!repoOk && draft.ghRepo !== ""}
                onChange={(e) => setDraft({ ...draft, ghRepo: e.target.value })}
              />
            </label>
            {!repoOk && draft.ghRepo && <p className="field-error">Write it as owner/name.</p>}
            <div className="field-pair">
              <label className="field">
                Branch
                <input autoCapitalize="none" spellCheck={false} value={draft.ghBranch} onChange={(e) => setDraft({ ...draft, ghBranch: e.target.value })} />
              </label>
              <label className="field">
                Folder
                <input autoCapitalize="none" spellCheck={false} placeholder="(root)" value={draft.ghPath} onChange={(e) => setDraft({ ...draft, ghPath: e.target.value })} />
              </label>
            </div>
            <label className="field">
              Token
              <span className="token-row">
                <input
                  type={showToken ? "text" : "password"}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="github_pat_…"
                  value={draft.token}
                  onChange={(e) => setDraft({ ...draft, token: e.target.value })}
                />
                <button type="button" className="chip-btn" aria-pressed={showToken} onClick={() => setShowToken((v) => !v)}>
                  {showToken ? "Hide" : "Show"}
                </button>
              </span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={draft.rememberToken} onChange={(e) => setDraft({ ...draft, rememberToken: e.target.checked })} />
              Remember the token on this device
            </label>
            <p className="hint">
              Use a{" "}
              <a href={TOKEN_HELP_URL} target="_blank" rel="noopener noreferrer">
                fine-grained token
              </a>{" "}
              limited to the data repository, with <strong>Contents: read-only</strong> and nothing else. It is sent only to
              api.github.com and never put in a URL. A remembered token is readable by any page on this site's origin
              (every GitHub Pages site of the same account), which is why it should grant nothing more.
            </p>
            {(settings.token || draft.token) && (
              <button
                type="button"
                className="danger-btn"
                onClick={async () => {
                  setDraft({ ...draft, token: "" });
                  await forgetToken();
                }}
              >
                Forget token
              </button>
            )}
          </fieldset>
        )}

        {showError && (
          <p className="field-error" role="alert">
            {load.error!.message}
          </p>
        )}
        {/* Enter in any field submits. */}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
