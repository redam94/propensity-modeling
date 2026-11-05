/** Remember the last configured dataset (and worksheet) for the sidebar "Configure" link. */
const ID_KEY = "lastDatasetId";
const SHEET_KEY = "lastDatasetSheet";

export function rememberDataset(id: string, sheet?: string | null) {
  try {
    localStorage.setItem(ID_KEY, id);
    if (sheet) localStorage.setItem(SHEET_KEY, sheet);
    else localStorage.removeItem(SHEET_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function forgetDataset(id: string) {
  try {
    if (localStorage.getItem(ID_KEY) === id) {
      localStorage.removeItem(ID_KEY);
      localStorage.removeItem(SHEET_KEY);
    }
  } catch {
    /* storage unavailable */
  }
}

/** Path for the sidebar Configure link: last dataset + sheet, or the picker. */
export function lastConfigurePath(): string {
  try {
    const id = localStorage.getItem(ID_KEY);
    if (!id) return "/configure";
    const sheet = localStorage.getItem(SHEET_KEY);
    return `/configure/${id}${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`;
  } catch {
    return "/configure";
  }
}
