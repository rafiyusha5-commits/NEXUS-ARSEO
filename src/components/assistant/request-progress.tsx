export function RequestProgress({ label }: { label: string }) {
  return <div className="assistant-progress" role="status" aria-live="polite">
    <p>{label}</p>
    <div className="assistant-progress-track" role="progressbar" aria-label={label}>
      <span className="assistant-progress-fill" />
    </div>
  </div>;
}
