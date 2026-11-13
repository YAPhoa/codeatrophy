/** Stands in for a part that cannot be loaded because the server was upgraded while this tab was open. */
export function ReloadNotice() {
  return (
    <p className="reload-notice" role="status">
      Updated.{' '}
      <button type="button" className="link-btn" onClick={() => window.location.reload()}>
        Reload
      </button>{' '}
      to continue.
    </p>
  );
}
