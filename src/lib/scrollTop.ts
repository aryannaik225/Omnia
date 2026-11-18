/**
 * "Tap the current tab again to go back to the top": the sidebar / tab bar fire this when the
 * clicked view is already open, and the app shell smooth-scrolls its main container to 0.
 */
export const SCROLL_TOP_EVENT = "omnia:scroll-top";

export const requestScrollTop = () => window.dispatchEvent(new Event(SCROLL_TOP_EVENT));
