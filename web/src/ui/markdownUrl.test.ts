import { describe, expect, it } from 'vitest';
import { markdownUrlTransform } from './markdownUrl';

type Node = Parameters<typeof markdownUrlTransform>[2];
const el = (tagName: string) => ({ type: 'element', tagName, properties: {}, children: [] }) as Node;
const src = (url: string) => markdownUrlTransform(url, 'src', el('img'));
const href = (url: string) => markdownUrlTransform(url, 'href', el('a'));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

describe('markdownUrlTransform', () => {
  it('lets an image be a data URL of a picture, base64 or URL-encoded', () => {
    expect(src(PNG)).toBe(PNG);
    expect(src(SVG)).toBe(SVG);
    for (const type of ['jpeg', 'gif', 'webp']) expect(src(`data:image/${type};base64,AAAA`)).toBe(`data:image/${type};base64,AAAA`);
    expect(src('data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+')).toBe('data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+');
    expect(src('DATA:IMAGE/PNG;BASE64,AAAA')).toBe('DATA:IMAGE/PNG;BASE64,AAAA');
  });

  it('drops data URLs of anything else, and on anything but an image', () => {
    expect(src('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
    expect(src('data:image/x-icon;base64,AAAA')).toBe('');
    expect(src('data:image/svg+xml')).toBe('');
    expect(src('data:image/svg+xml;foo=<x>,AAAA')).toBe('');
    expect(href(PNG)).toBe('');
    expect(href(SVG)).toBe('');
    expect(markdownUrlTransform(PNG, 'src', el('video'))).toBe('');
  });

  it('leaves other URLs to the default filter', () => {
    expect(href('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
    expect(href('mailto:a@example.com')).toBe('mailto:a@example.com');
    expect(href('#h-input')).toBe('#h-input');
    expect(href('/items/1')).toBe('/items/1');
    expect(src('https://example.com/p.png')).toBe('https://example.com/p.png');
    expect(href('javascript:alert(1)')).toBe('');
    expect(src('javascript:alert(1)')).toBe('');
    expect(href('vbscript:x')).toBe('');
  });
});
