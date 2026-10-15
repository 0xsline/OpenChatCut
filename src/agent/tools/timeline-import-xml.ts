// Minimal DOM access shared by the FCPXML import modules. It only uses APIs that
// both the browser's DOMParser and @xmldom/xmldom (offline MCP server) provide.
import type { Document as XmlDocument, Element as XmlElement } from '@xmldom/xmldom';

export type { XmlDocument, XmlElement };
export type XmlParserConstructor = typeof import('@xmldom/xmldom').DOMParser;

export function attr(element: XmlElement, name: string): string {
  return element.getAttribute(name)?.trim() ?? '';
}

export function hasAttr(element: XmlElement, name: string): boolean {
  return element.getAttribute(name) !== null;
}

/** Descendants with the given tag, in document order. */
export function elements(root: XmlDocument | XmlElement, tag: string): XmlElement[] {
  const nodes = root.getElementsByTagName(tag);
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index))
    .filter((node): node is XmlElement => node?.nodeType === 1);
}

/** Direct element children, in document order. */
export function childElements(parent: XmlElement): XmlElement[] {
  const nodes = parent.childNodes;
  const children: XmlElement[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes.item(index);
    if (node?.nodeType === 1) children.push(node as XmlElement);
  }
  return children;
}

export function firstChild(parent: XmlElement, tag: string): XmlElement | undefined {
  return childElements(parent).find((child) => child.tagName === tag);
}
