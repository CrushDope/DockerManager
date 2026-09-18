import { isMap, isNode, LineCounter, parseAllDocuments } from 'yaml';

export type ComposeIssue = { message: string; line: number; column: number };

/** Syntax and basic shape only; the Docker host must run `docker compose config` before deployment. */
export function validateCompose(source: string): ComposeIssue[] {
  const lines = new LineCounter();
  const issue = (message: string, offset = 0): ComposeIssue => ({ message, line: lines.linePos(offset).line, column: lines.linePos(offset).col });
  if (!source.trim()) return [{ message: '请输入 docker-compose.yml 文件内容。', line: 1, column: 1 }];
  try {
    const docs = parseAllDocuments(source, { lineCounter: lines, uniqueKeys: true, prettyErrors: false, merge: true });
    const errors = docs.flatMap(doc => doc.errors.map(error => {
      const hints: Record<string, string> = {
        TAB_AS_INDENT: '缩进不能使用 Tab，请使用空格。',
        BAD_INDENT: '缩进层级不正确，请对齐同级字段。',
        DUPLICATE_KEY: '存在重复字段，请删除或合并同名字段。',
        MULTILINE_IMPLICIT_KEY: '字段跨行或缩进不正确，请检查冒号和缩进。',
        MISSING_CHAR: '缺少必要符号，请检查冒号、引号或括号。',
        UNEXPECTED_TOKEN: '存在意外内容，请检查缩进和符号。',
      };
      return issue(`${hints[error.code] || 'YAML 格式错误。'} ${error.message}`, error.pos[0]);
    }));
    if (errors.length) return errors;
    if (docs.length !== 1) return [issue('一个 Compose 文件只能包含一个 YAML 文档。')];
    const doc = docs[0];
    if (!isMap(doc.contents)) return [issue('文件顶层必须是键值映射，例如 services:，不能是列表或普通文本。')];
    // Resolve aliases and merge keys safely; expansion is bounded by the parser.
    const value = doc.toJS({ maxAliasCount: 100 });
    const mapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const servicesNode = doc.get('services', true);
    if (!mapping(value.services) || !Object.keys(value.services).length) {
      return [issue('services 必须包含至少一个服务，服务名应缩进在 services 下。', isNode(servicesNode) ? servicesNode.range?.[0] ?? 0 : 0)];
    }
    const shapeErrors: ComposeIssue[] = [];
    for (const [name, service] of Object.entries(value.services)) {
      const node = isMap(servicesNode) ? servicesNode.get(name, true) : undefined;
      const offset = node && typeof node === 'object' && 'range' in node ? (node.range?.[0] ?? 0) : 0;
      if (!mapping(service)) shapeErrors.push(issue(`服务 ${name} 必须是键值映射，请检查其配置是否正确缩进。`, offset));
      else {
        if ('image' in service && typeof service.image !== 'string') shapeErrors.push(issue(`服务 ${name} 的 image 必须是字符串。`, offset));
        if ('ports' in service && !Array.isArray(service.ports)) shapeErrors.push(issue(`服务 ${name} 的 ports 必须是列表，每项使用 - 开头。`, offset));
      }
    }
    return shapeErrors;
  } catch (error) {
    return [issue(`无法解析 YAML：${error instanceof Error ? error.message : '请检查文件内容'}`)];
  }
}
