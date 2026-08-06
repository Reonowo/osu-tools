import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { open } from "@tauri-apps/plugin-dialog";
import { DISPLAY_LENGTH_MAX, DISPLAY_LENGTH_MIN } from "@/state/defaults";
import { useViewerStore, type OverlaySettings } from "@/state/store";

const OVERLAY_TOGGLES: { key: keyof OverlaySettings; label: string }[] = [
  { key: "clickMarkers", label: "show click markers" },
  { key: "frameMarkers", label: "show frame markers" },
  { key: "cursorPath", label: "show cursor path" },
  { key: "hideCursor", label: "hide gameplay cursor" },
  { key: "keyOverlay", label: "show key overlay" },
];

export function SettingsDialog({ open: isOpen, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const settings = useViewerStore((s) => s.settings);
  const overlays = useViewerStore((s) => s.overlays);
  const setOverlay = useViewerStore((s) => s.setOverlay);
  const loadSettings = useViewerStore((s) => s.loadSettings);
  const saveStablePath = useViewerStore((s) => s.saveStablePath);
  const [saving, setSaving] = useState(false);

  // the field holds its own draft so a half-typed "5" of "500" is not clamped
  // to the 200 floor between keystrokes; the store only sees committed values
  // (blur, stepper press, arrow key) and clamps them there
  const displayLength = overlays.displayLength;
  const [draftLength, setDraftLength] = useState<number | null>(displayLength);
  useEffect(() => setDraftLength(displayLength), [displayLength]);

  function commitLength(value: number | null) {
    // an emptied field commits null: restore the last good value rather than
    // leaving the input blank with the store silently unchanged
    if (value === null) setDraftLength(displayLength);
    else setOverlay("displayLength", value);
  }

  useEffect(() => {
    if (isOpen) void loadSettings();
  }, [isOpen, loadSettings]);

  async function pickInstall() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir !== "string") return;
    setSaving(true);
    await saveStablePath(dir).finally(() => setSaving(false));
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>settings</DialogTitle></DialogHeader>

        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">osu! stable install</h3>
          <div className="flex items-center gap-2 text-sm">
            <code className="min-w-0 flex-1 truncate rounded bg-zinc-800 px-2 py-1 text-xs">
              {settings?.osuStablePath ?? "auto-detect"}
            </code>
            <Button size="sm" variant="secondary" disabled={saving} onClick={() => void pickInstall()}>
              browse
            </Button>
            <Button
              size="sm" variant="ghost" disabled={saving || settings?.osuStablePath == null}
              onClick={() => void saveStablePath(null)}
            >
              reset
            </Button>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-zinc-500 uppercase">analysis overlays</h3>
          {OVERLAY_TOGGLES.map(({ key, label }) => (
            <label key={key} className="flex items-center justify-between text-sm">
              {label}
              <Switch
                checked={overlays[key] as boolean}
                onCheckedChange={(v) => setOverlay(key, v as OverlaySettings[typeof key])}
              />
            </label>
          ))}
          <label className="flex items-center justify-between gap-4 text-sm">
            display length
            <span className="flex items-center gap-2">
              <NumberField
                min={DISPLAY_LENGTH_MIN} max={DISPLAY_LENGTH_MAX} step={50} largeStep={200}
                value={draftLength}
                onValueChange={setDraftLength}
                onValueCommitted={commitLength}
              />
              <span className="text-zinc-400">ms</span>
            </span>
          </label>
        </section>
      </DialogContent>
    </Dialog>
  );
}
