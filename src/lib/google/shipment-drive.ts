import { DriveReadonly, DriveReadError, type DriveFile, type DriveFolder } from "./drive-readonly.ts";

// Explicitly approved by the owner. Never populate this list from a form or a model.
export const SHIPMENT_DRIVE_ROOT = "1ffI_2N0F9Gy3N8r5XgNRv-hipmCl1ele";
export const FUTURE_ORDERS_DRIVE_ROOT = "1H0DGNKrBgsIGdUvWqN2BHajjdgXmvvCC";
const ROOTS = [SHIPMENT_DRIVE_ROOT, FUTURE_ORDERS_DRIVE_ROOT] as const;
export function isShipmentDriveRoot(id: string) { return ROOTS.some(root => root === id); }

/** Resolve once, then pin every list/download/recheck to that same approved tree. */
export class ShipmentDriveReadonly {
  private readers: DriveReadonly[];
  private selected: DriveReadonly | undefined;

  constructor(token: (signal: AbortSignal) => Promise<string>, fetcher: typeof fetch = fetch) {
    this.readers = ROOTS.map(root => new DriveReadonly(token, fetcher, root));
  }

  async scopedReference(id: string, signal: AbortSignal): Promise<DriveFile> {
    if (this.selected) return this.selected.scopedReference(id, signal);
    for (const reader of this.readers) {
      try {
        const file = await reader.scopedReference(id, signal);
        this.selected = reader;
        return file;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof DriveReadError)) throw error;
      }
    }
    throw new DriveReadError();
  }

  async catalogPage(folder: DriveFolder, signal: AbortSignal) {
    if (!this.selected) throw new DriveReadError();
    return this.selected.catalogPage(folder, signal);
  }

  async download(id: string, signal: AbortSignal) {
    if (!this.selected) throw new DriveReadError();
    return this.selected.download(id, signal);
  }
}
