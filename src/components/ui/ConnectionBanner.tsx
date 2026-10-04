import { translate as tr, useLocale } from "../../i18n";
type ConnectionBannerProps = {
  connected: boolean;
  lastValidSnapshotAt: number | null;
  snapshotError: string | null;
  now: number;
  stale: boolean;
};

function formatAge(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function ConnectionBanner({
  connected,
  lastValidSnapshotAt,
  snapshotError,
  now,
  stale,
}: ConnectionBannerProps) {
  useLocale();
  if (connected && !snapshotError && !stale) return null;

  let message = tr("Connecting to live telemetry…");
  if (snapshotError) message = tr(snapshotError);
  else if (lastValidSnapshotAt != null) {
    const age = formatAge(now - lastValidSnapshotAt);
    message = connected
      ? tr("Telemetry is stale. Last valid update was {0} ago.", [age])
      : tr("Live telemetry disconnected. Showing data from {0} ago.", [age]);
  } else if (!connected) {
    message = tr("Live telemetry is disconnected. Waiting for the first valid update…");
  }

  const announced = snapshotError
    ? tr("Telemetry data error.")
    : connected
      ? tr("Telemetry is stale.")
      : tr("Live telemetry is disconnected.");

  return (
    <div className="connection-banner">
      <span className="connection-banner-dot" aria-hidden="true" />
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
      <span aria-hidden="true">{message}</span>
    </div>
  );
}
