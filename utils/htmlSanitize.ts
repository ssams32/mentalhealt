const ALLOWED_TAGS = new Set([
    'a', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
    'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'li', 'ol', 'p', 'pre', 's',
    'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'tr', 'u', 'ul',
]);

const TAGS_REMOVED_WITH_CONTENT = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button',
    'textarea', 'select', 'option', 'svg', 'math', 'template', 'noscript', 'frame', 'frameset', 'applet',
    'audio', 'video', 'source', 'track',
]);

const ALLOWED_ATTRIBUTES = new Set(['colspan', 'rowspan', 'align', 'valign', 'title', 'alt', 'width', 'height', 'start']);

const SAFE_LINK_SCHEME = /^(https?:|mailto:|tel:|#)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.\-]*:/i;
const INLINE_RASTER_IMAGE = /^data:image\/(png|jpe?g|gif|bmp|webp);base64,[a-z0-9+/=\s]+$/i;
const SCHEME_OBFUSCATION_CHARACTERS = /[\u0000- \u007f-\u009f​-‍﻿]/g;

const isSafeLinkUrl = (rawUrl: string): boolean => {
    const url = rawUrl.replace(SCHEME_OBFUSCATION_CHARACTERS, '');
    return url !== '' && (SAFE_LINK_SCHEME.test(url) || !ANY_SCHEME.test(url));
};

const isSafeImageUrl = (rawUrl: string): boolean =>
    /^data:/i.test(rawUrl.trim()) ? INLINE_RASTER_IMAGE.test(rawUrl.trim()) : isSafeLinkUrl(rawUrl);

const isAllowedAttribute = (tag: string, attribute: Attr): boolean => {
    const name = attribute.name.toLowerCase();
    if (tag === 'a' && name === 'href') return isSafeLinkUrl(attribute.value);
    if (tag === 'img' && name === 'src') return isSafeImageUrl(attribute.value);
    return ALLOWED_ATTRIBUTES.has(name);
};

const unwrap = (element: Element): void => {
    element.replaceWith(...Array.from(element.childNodes));
};

const sanitizeChildren = (parent: Node): void => {
    Array.from(parent.childNodes).forEach(child => {
        if (child.nodeType === Node.TEXT_NODE) return;
        if (child.nodeType !== Node.ELEMENT_NODE) {
            child.remove();
            return;
        }
        const element = child as Element;
        const tag = element.tagName.toLowerCase();
        if (TAGS_REMOVED_WITH_CONTENT.has(tag)) {
            element.remove();
            return;
        }
        sanitizeChildren(element);
        if (!ALLOWED_TAGS.has(tag)) {
            unwrap(element);
            return;
        }
        Array.from(element.attributes)
            .filter(attribute => !isAllowedAttribute(tag, attribute))
            .forEach(attribute => element.removeAttribute(attribute.name));
        if (tag === 'a') {
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
        }
    });
};

export function sanitizePreviewHtml(html: string): string {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    sanitizeChildren(parsed.body);
    return parsed.body.innerHTML;
}
