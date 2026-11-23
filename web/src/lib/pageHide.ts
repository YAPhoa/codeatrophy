/**
 * Call `flush` when the page goes away or its tab is hidden: the last moment
 * a save is sure to be sent, since a hidden tab may be closed without another
 * event. Returns what stops listening.
 */
export function onPageHide(flush: () => void): () => void {
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onHidden);
  return () => {
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onHidden);
  };
}
