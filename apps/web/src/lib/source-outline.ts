import type { FootnoteDefinition, Nodes } from 'mdast';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export const sourceRemarkPlugins = [remarkGfm, remarkMath];
const parser = unified().use(remarkParse).use(sourceRemarkPlugins).freeze();
type SourceHeading = { depth: 1 | 2 | 3 | 4 | 5 | 6; text: string; line: number };

function plainText(node: Nodes): string {
  if ('children' in node) return node.children.map(plainText).join('');
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if (node.type === 'html' || node.type === 'footnoteReference') return '';
  if (node.type === 'text') return node.value.replace(/\r?\n/g, ' ');
  return 'value' in node ? node.value : '';
}

export function sourceOutline(text: string): SourceHeading[] {
  const tree = parser.parse(text);
  const definitions = new Map<string, FootnoteDefinition>();
  const used = new Set<FootnoteDefinition>();
  const headings: SourceHeading[] = [];
  function collect(node: Nodes) {
    if (node.type === 'footnoteDefinition' && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node);
    if ('children' in node) node.children.forEach(collect);
  }
  function references(node: Nodes) {
    if (node.type === 'footnoteDefinition') return;
    if (node.type === 'footnoteReference') {
      const definition = definitions.get(node.identifier.toUpperCase());
      if (definition && !used.has(definition)) { used.add(definition); definition.children.forEach(references); }
    }
    if ('children' in node) node.children.forEach(references);
  }
  function visit(node: Nodes) {
    // GFM only renders referenced footnotes; later duplicate definitions are hidden.
    if (node.type === 'footnoteDefinition' && !used.has(node)) return;
    if (node.type === 'heading' && node.position) headings.push({ depth: node.depth, text: plainText(node).trim(), line: node.position.start.line });
    if ('children' in node) node.children.forEach(visit);
  }
  collect(tree); references(tree); visit(tree);
  return headings;
}
