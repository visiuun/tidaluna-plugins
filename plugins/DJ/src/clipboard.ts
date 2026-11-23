/**
 * Puts text on the clipboard; false: it isn't there.
 * Through a copy of the page's own, with the text put in as it happens: that needs nothing selected and no focus.
 * (TIDAL's page turns selecting off everywhere, so a hidden text field's text was never selected, and the copy of
 * it said it went fine with nothing copied; the modern way refuses whenever the page doesn't hold the focus.)
 */
export const copyText = async (text: string) => {
  let put = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    e.stopImmediatePropagation();
    put = true;
  };
  window.addEventListener("copy", onCopy, true);
  try {
    document.execCommand("copy");
  } catch {
    // (the modern way is next)
  } finally {
    window.removeEventListener("copy", onCopy, true);
  }
  if (put) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
