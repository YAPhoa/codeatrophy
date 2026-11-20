import { defaultUrlTransform, type UrlTransform } from 'react-markdown';

// An image may be embedded in the text as a data URL of a raster or SVG image,
// base64 or URL-encoded. Only an <img> gets one: a browser draws an SVG shown
// that way as a picture and never runs its scripts. The size needs no bound of
// its own here; the item text it sits in has one (`maxTextBytes`).
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;[a-z0-9._+-]+(?:=[a-z0-9._+-]+)?)*,/i;

export function isDataImage(url: string): boolean {
  return DATA_IMAGE.test(url);
}

/**
 * react-markdown's own filter, which drops `javascript:`, `data:` and other
 * unsafe URLs, except that an image's `src` may be a data URL of an image.
 * Links to data URLs stay dropped.
 */
export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img' && isDataImage(url)) return url;
  return defaultUrlTransform(url);
};
