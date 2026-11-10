/**
 * Per-device settings: which data source, the GitHub token, the theme.
 *
 * Persisted through a zodal `DataProvider` (the store interface), never through
 * direct `localStorage` calls. The default provider is
 * `@zodal/store-localstorage`; swapping in another provider (IndexedDB, a
 * session-only store, a test double) changes one argument, not the app.
 *
 * Security notes, because the page is public and the data repo is private:
 * - The token is stored only when the person ticks "Remember on this device";
 *   otherwise it lives in memory and is gone on reload.
 * - Every page under https://<user>.github.io/ shares one origin, so any other
 *   Pages site of the same account could read a remembered token. Hence the
 *   advice in the UI: a fine-grained token, read-only, limited to the data repo.
 */
import * as z from "zod/mini";
import type { DataProvider } from "@zodal/store";
import { createLocalStorageProvider } from "@zodal/store-localstorage";

export const SETTINGS_ID = "settings";
export const SETTINGS_STORAGE_KEY = "ghtraffic.settings.v1";

export const THEMES = ["system", "light", "dark"] as const;

export const SettingsSchema = z.object({
  id: z.catch(z.literal(SETTINGS_ID), SETTINGS_ID),
  /** "url" = a public data URL (empty = the bundled demo); "github" = a private repo. */
  source: z.catch(z.enum(["url", "github"]), "url"),
  url: z.catch(z.string(), ""),
  ghRepo: z.catch(z.string(), ""),
  ghBranch: z.catch(z.string(), "main"),
  ghPath: z.catch(z.string(), ""),
  token: z.catch(z.string(), ""),
  rememberToken: z.catch(z.boolean(), false), // opt-in: a remembered token is readable by every page on this origin
  theme: z.catch(z.enum(THEMES), "system"),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** The provider used by the app (one record, id "settings"). */
export function defaultSettingsProvider(): DataProvider<Settings> {
  return createLocalStorageProvider<Settings>({ storageKey: SETTINGS_STORAGE_KEY, idField: "id" });
}

/** Read settings; anything missing or invalid falls back to defaults. Never throws. */
export async function loadSettings(provider: DataProvider<Settings>): Promise<Settings> {
  try {
    return SettingsSchema.parse(await provider.getOne(SETTINGS_ID));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** What actually gets written: the token only when the person chose to remember it. */
export const toStored = (s: Settings): Settings => ({ ...s, token: s.rememberToken ? s.token : "" });

/** Write settings. Storage can be unavailable (private mode, quota): report, don't throw. */
export async function saveSettings(provider: DataProvider<Settings>, s: Settings): Promise<boolean> {
  const record = toStored(s);
  try {
    if (provider.upsert) await provider.upsert(record);
    else {
      try {
        await provider.update(SETTINGS_ID, record);
      } catch {
        await provider.create(record);
      }
    }
    return true;
  } catch {
    return false;
  }
}
