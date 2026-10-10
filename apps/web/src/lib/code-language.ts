import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';

const languages = { python: python(), javascript: javascript(), typescript: javascript({ typescript: true }) };
const aliases = { py: 'python', js: 'javascript', ts: 'typescript' } as const;
export function codeLanguage(name: string) {
  const key = Object.hasOwn(aliases, name) ? aliases[name as keyof typeof aliases] : name;
  return Object.hasOwn(languages, key) ? languages[key as keyof typeof languages] : undefined;
}
