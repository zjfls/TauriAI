export type SymbolSearchRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type OutlineSymbolNode = {
  key: string;
  name: string;
  kind: string;
  detail: string;
  range: SymbolSearchRange;
  selectionLine: number;
  selectionColumn: number;
  children: OutlineSymbolNode[];
};

export type SymbolSearchItem = {
  id: string;
  name: string;
  kind: string;
  detail: string;
  containerName: string;
  filePath: string;
  selectionLine: number;
  selectionColumn: number;
  range: SymbolSearchRange;
  outlineKey?: string;
  score?: number;
};

export type SymbolSearchContext = {
  activeFilePath?: string | null;
  activeDirPath?: string | null;
  openFilePaths?: Iterable<string>;
};

const normalizePathForSearch = (value: string): string =>
  String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();

const normalizeTextForSearch = (value: string): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[_/\\.:#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenizeSearchQuery = (query: string): string[] => {
  const normalized = normalizeTextForSearch(query);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
};

const buildInitials = (value: string): string => {
  const tokens = normalizeTextForSearch(value).split(" ").filter(Boolean);
  return tokens.map((token) => token[0] ?? "").join("");
};

const scoreSubsequenceMatch = (text: string, token: string): number | null => {
  if (!text || !token) return null;
  let cursor = -1;
  let gaps = 0;
  for (const ch of token) {
    const next = text.indexOf(ch, cursor + 1);
    if (next < 0) return null;
    gaps += Math.max(0, next - cursor - 1);
    cursor = next;
  }
  return Math.max(
    80,
    260 - Math.min(180, gaps * 6 + Math.max(0, text.length - token.length) * 2),
  );
};

const scoreFieldMatch = (field: string, token: string): number | null => {
  if (!field || !token) return null;
  if (field === token) return 1200;
  if (field.startsWith(token))
    return 1040 - Math.min(140, Math.max(0, field.length - token.length) * 4);

  const words = field.split(" ").filter(Boolean);
  if (words.some((word) => word === token)) return 980;
  if (words.some((word) => word.startsWith(token))) return 900;

  const substringIndex = field.indexOf(token);
  if (substringIndex >= 0) {
    return (
      760 -
      Math.min(220, substringIndex * 6) -
      Math.min(140, Math.max(0, field.length - token.length) * 2)
    );
  }

  const compactField = field.replace(/\s+/g, "");
  const compactToken = token.replace(/\s+/g, "");
  if (compactField && compactToken) {
    const initials = buildInitials(field);
    if (initials === compactToken) return 720;
    if (initials.startsWith(compactToken))
      return (
        660 -
        Math.min(120, Math.max(0, initials.length - compactToken.length) * 8)
      );

    const subsequence = scoreSubsequenceMatch(compactField, compactToken);
    if (subsequence !== null) return 360 + subsequence;
  }

  return null;
};

export const compareSymbolItemsByPosition = (
  a: SymbolSearchItem,
  b: SymbolSearchItem,
): number => {
  if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
  if (a.selectionLine !== b.selectionLine)
    return a.selectionLine - b.selectionLine;
  if (a.selectionColumn !== b.selectionColumn)
    return a.selectionColumn - b.selectionColumn;
  const kindDiff = a.kind.localeCompare(b.kind);
  if (kindDiff !== 0) return kindDiff;
  return a.name.localeCompare(b.name);
};

export const scoreSymbolSearchItem = (
  item: SymbolSearchItem,
  query: string,
  context?: SymbolSearchContext,
): number | null => {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return 0;

  const normalizedName = normalizeTextForSearch(item.name);
  const normalizedKind = normalizeTextForSearch(item.kind);
  const normalizedDetail = normalizeTextForSearch(item.detail);
  const normalizedContainer = normalizeTextForSearch(item.containerName);
  const normalizedFilePath = normalizePathForSearch(item.filePath);
  const normalizedPathText = normalizeTextForSearch(item.filePath);

  let score = 0;
  for (const token of tokens) {
    const fieldScores = [
      scoreFieldMatch(normalizedName, token),
      scoreFieldMatch(normalizedContainer, token) !== null
        ? (scoreFieldMatch(normalizedContainer, token) as number) - 180
        : null,
      scoreFieldMatch(normalizedKind, token) !== null
        ? (scoreFieldMatch(normalizedKind, token) as number) - 260
        : null,
      scoreFieldMatch(normalizedPathText, token) !== null
        ? (scoreFieldMatch(normalizedPathText, token) as number) - 320
        : null,
      scoreFieldMatch(normalizedDetail, token) !== null
        ? (scoreFieldMatch(normalizedDetail, token) as number) - 380
        : null,
    ].filter((value): value is number => value !== null);

    if (fieldScores.length === 0) return null;
    score += Math.max(...fieldScores);
  }

  if (context) {
    const activeFilePath = normalizePathForSearch(context.activeFilePath ?? "");
    if (activeFilePath && normalizedFilePath === activeFilePath) score += 180;

    const activeDirPath = normalizePathForSearch(context.activeDirPath ?? "");
    if (activeDirPath && normalizedFilePath.startsWith(`${activeDirPath}/`))
      score += 40;

    if (context.openFilePaths) {
      for (const openPath of context.openFilePaths) {
        if (normalizedFilePath === normalizePathForSearch(openPath)) {
          score += 60;
          break;
        }
      }
    }
  }

  score -= Math.min(100, Math.max(0, item.selectionLine - 1));
  return score;
};

export const rankSymbolSearchItems = (
  items: SymbolSearchItem[],
  query: string,
  context?: SymbolSearchContext,
): SymbolSearchItem[] => {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) {
    return [...items].sort(compareSymbolItemsByPosition);
  }

  return items
    .map((item) => {
      const score = scoreSymbolSearchItem(item, query, context);
      return score === null ? null : { ...item, score };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const scoreDiff = (b?.score ?? 0) - (a?.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      const nameDiff = a!.name.localeCompare(b!.name);
      if (nameDiff !== 0) return nameDiff;
      return compareSymbolItemsByPosition(a!, b!);
    }) as SymbolSearchItem[];
};

export const flattenOutlineSymbolNodes = <T extends OutlineSymbolNode>(
  nodes: T[],
  filePath: string,
  parentNames: string[] = [],
): SymbolSearchItem[] => {
  const results: SymbolSearchItem[] = [];
  for (const node of nodes) {
    const containerName = parentNames.join(" › ");
    results.push({
      id: `outline:${filePath}:${node.key}`,
      name: node.name,
      kind: node.kind,
      detail: node.detail,
      containerName,
      filePath,
      selectionLine: node.selectionLine,
      selectionColumn: node.selectionColumn,
      range: node.range,
      outlineKey: node.key,
    });
    if (Array.isArray(node.children) && node.children.length > 0) {
      results.push(
        ...flattenOutlineSymbolNodes(node.children as T[], filePath, [
          ...parentNames,
          node.name,
        ]),
      );
    }
  }
  return results;
};

export const filterOutlineSymbolTree = <T extends OutlineSymbolNode>(
  nodes: T[],
  filePath: string,
  query: string,
  context?: SymbolSearchContext,
  parentNames: string[] = [],
): { items: T[]; matchedKeys: Set<string>; matchCount: number } => {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) {
    return { items: nodes, matchedKeys: new Set<string>(), matchCount: 0 };
  }

  const matchedKeys = new Set<string>();
  let matchCount = 0;

  const walk = (list: T[], ancestors: string[]): T[] => {
    const next: T[] = [];
    for (const node of list) {
      const containerName = ancestors.join(" › ");
      const score = scoreSymbolSearchItem(
        {
          id: `outline:${filePath}:${node.key}`,
          name: node.name,
          kind: node.kind,
          detail: node.detail,
          containerName,
          filePath,
          selectionLine: node.selectionLine,
          selectionColumn: node.selectionColumn,
          range: node.range,
          outlineKey: node.key,
        },
        query,
        context,
      );
      const children =
        Array.isArray(node.children) && node.children.length > 0
          ? walk(node.children as T[], [...ancestors, node.name])
          : [];
      if (score !== null || children.length > 0) {
        if (score !== null) {
          matchedKeys.add(node.key);
          matchCount += 1;
        }
        next.push({ ...node, children } as T);
      }
    }
    return next;
  };

  return {
    items: walk(nodes, parentNames),
    matchedKeys,
    matchCount,
  };
};
