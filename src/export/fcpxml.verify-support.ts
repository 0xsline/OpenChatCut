// FCPXML 1.10 DTD subset for the elements timelineToFcpxml emits. Final Cut Pro
// validates every imported document against its DTD and rejects the whole file
// on the first violation ("DTD validation failed"), so the verifies check the
// serializer's output against these content models instead of string snippets.
// Transcribed from Apple's FCPXMLv1_10.dtd (mirrored by CommandPost at
// src/extensions/cp/apple/fcpxml/dtd/); the DTD itself is not vendored.
// Any element outside this table counts as undeclared, which is what an
// FCPXML 1.10 validator reports for FCP7-only elements such as <pathurl>.

const ANCHOR = '(?:audio|video|clip|title|caption|mc-clip|ref-clip|sync-clip|asset-clip|audition|spine) ';
const MARKER = '(?:marker|chapter-marker|rating|keyword|analysis-marker) ';
const CLIP_ITEM = '(?:audio|video|clip|title|mc-clip|ref-clip|sync-clip|asset-clip|audition|gap|transition) ';

interface ElementRule {
  /** Child element names, each followed by one space, must match this. */
  readonly content: RegExp;
  readonly attributes: readonly string[];
  readonly required?: readonly string[];
}

const RULES: Readonly<Record<string, ElementRule>> = {
  fcpxml: { content: /^(?:import-options )?(?:resources )?(?:library |(?:event )*)$/, attributes: ['version'], required: ['version'] },
  resources: { content: /^(?:(?:asset|effect|format|media|locator) )*$/, attributes: [] },
  format: {
    content: /^$/,
    attributes: ['id', 'name', 'frameDuration', 'fieldOrder', 'width', 'height', 'paspH', 'paspV', 'colorSpace', 'projection', 'stereoscopic'],
    required: ['id'],
  },
  asset: {
    content: /^(?:media-rep )+(?:metadata )?$/,
    attributes: ['id', 'name', 'uid', 'start', 'duration', 'hasVideo', 'format', 'hasAudio', 'videoSources', 'audioSources',
      'audioChannels', 'audioRate', 'customLUTOverride', 'colorSpaceOverride', 'projectionOverride', 'stereoscopicOverride', 'auxVideoFlags'],
    required: ['id'],
  },
  'media-rep': { content: /^(?:bookmark )?$/, attributes: ['kind', 'sig', 'src', 'suggestedFilename'], required: ['src'] },
  bookmark: { content: /^$/, attributes: [] },
  metadata: { content: /^(?:md )*$/, attributes: [] },
  md: { content: /^(?:array )?$/, attributes: ['key', 'value', 'editable', 'type', 'displayName', 'description', 'source'], required: ['key'] },
  library: { content: /^(?:(?:event|smart-collection) )*$/, attributes: ['location', 'colorProcessing'] },
  event: {
    content: /^(?:(?:clip|audition|mc-clip|ref-clip|sync-clip|asset-clip|keyword-collection|collection-folder|smart-collection|project) )*$/,
    attributes: ['name', 'uid'],
  },
  project: { content: /^sequence $/, attributes: ['name', 'uid', 'id', 'modDate'] },
  sequence: {
    content: /^(?:note )?spine (?:metadata )?$/,
    attributes: ['format', 'duration', 'tcStart', 'tcFormat', 'audioLayout', 'audioRate', 'renderFormat', 'keywords'],
    required: ['format'],
  },
  spine: { content: new RegExp(`^(?:${CLIP_ITEM})*$`), attributes: ['lane', 'offset', 'name', 'format'] },
  gap: {
    content: new RegExp(`^(?:note )?(?:${ANCHOR})*(?:${MARKER})*(?:metadata )?$`),
    attributes: ['name', 'offset', 'start', 'duration', 'enabled'],
    required: ['duration'],
  },
  'asset-clip': {
    content: new RegExp(`^(?:note )?(?:conform-rate )?(?:timeMap )?(?:(?:object-tracker|adjust-[a-zA-Z0-9-]+) )*`
      + `(?:${ANCHOR})*(?:${MARKER})*(?:audio-channel-source )*(?:(?:filter-video|filter-video-mask) )*(?:filter-audio )*(?:metadata )?$`),
    attributes: ['ref', 'lane', 'offset', 'name', 'start', 'duration', 'enabled', 'srcEnable', 'audioStart', 'audioDuration',
      'format', 'tcStart', 'tcFormat', 'modDate', 'audioRole', 'videoRole'],
    required: ['ref'],
  },
  timeMap: { content: /^(?:timept )*$/, attributes: ['frameSampling', 'preservesPitch'] },
  timept: { content: /^$/, attributes: ['time', 'value', 'interp', 'inTime', 'outTime'], required: ['time', 'value'] },
};

interface OpenElement {
  readonly name: string;
  readonly children: string[];
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z][\w.-]*)((?:\s+[A-Za-z_:][\w.:-]*="[^"]*")*)\s*(\/?)>/g;

function checkAttributes(name: string, rawAttributes: string, ids: Set<string>, refs: string[], violations: string[]): void {
  const rule = RULES[name];
  const seen = new Set<string>();
  for (const [, attribute, value] of rawAttributes.matchAll(/([A-Za-z_:][\w.:-]*)="([^"]*)"/g)) {
    seen.add(attribute!);
    if (rule && !rule.attributes.includes(attribute!)) violations.push(`No declaration for attribute ${attribute} of element ${name}`);
    if (attribute === 'id') ids.add(value!);
    if ((name === 'asset-clip' && attribute === 'ref') || ((name === 'asset' || name === 'sequence') && attribute === 'format')) {
      refs.push(value!);
    }
  }
  for (const attribute of rule?.required ?? []) {
    if (!seen.has(attribute)) violations.push(`Element ${name} does not carry required attribute ${attribute}`);
  }
}

function closeElement(element: OpenElement, violations: string[]): void {
  const rule = RULES[element.name];
  if (!rule) return;
  const sequence = element.children.map((child) => `${child} `).join('');
  if (!rule.content.test(sequence)) {
    violations.push(`Element ${element.name} content does not follow the DTD, got (${element.children.join(' ')})`);
  }
}

/** Every FCPXML 1.10 DTD violation found in the subset above; [] means valid. */
export function fcpxmlDtdViolations(xml: string): string[] {
  const violations: string[] = [];
  const stack: OpenElement[] = [];
  const ids = new Set<string>();
  const refs: string[] = [];
  let roots = 0;
  let cursor = 0;
  for (const match of xml.matchAll(TOKEN)) {
    // A '<' the tokenizer did not recognise is malformed markup, not text.
    if (xml.slice(cursor, match.index).includes('<')) violations.push(`Malformed markup near offset ${cursor}`);
    cursor = match.index + match[0].length;
    const [, closing, name, rawAttributes, selfClosing] = match;
    if (!name) continue;
    if (closing) {
      const open = stack.pop();
      if (open?.name !== name) return [...violations, `Mismatched end tag </${name}>`];
      closeElement(open, violations);
      continue;
    }
    if (!RULES[name]) violations.push(`No declaration for element ${name}`);
    stack.at(-1)?.children.push(name);
    if (stack.length === 0) roots += 1;
    checkAttributes(name, rawAttributes ?? '', ids, refs, violations);
    const element: OpenElement = { name, children: [] };
    if (selfClosing) closeElement(element, violations);
    else stack.push(element);
  }
  if (xml.slice(cursor).includes('<')) violations.push(`Malformed markup near offset ${cursor}`);
  if (stack.length > 0) violations.push(`Unclosed element <${stack.at(-1)!.name}>`);
  if (roots !== 1 || !xml.includes('<fcpxml ')) violations.push('Document must have exactly one <fcpxml> root');
  for (const ref of refs) {
    if (!ids.has(ref)) violations.push(`IDREF ${ref} does not match any ID`);
  }
  return violations;
}
