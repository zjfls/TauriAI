use serde::{Deserialize, Serialize};

/// AST 解析输出的 Position（与 LSP 一致：0-based line/character）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AstPosition {
    pub line: u32,
    pub character: u32,
}

/// AST 解析输出的 Range（与 LSP 一致：start/end）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AstRange {
    pub start: AstPosition,
    pub end: AstPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSymbol {
    pub name: String,
    /// 近似的 symbol kind（字符串，前端可映射到 Monaco/LSP 的 kind）
    pub kind: String,
    pub range: AstRange,
    pub selection_range: AstRange,
    #[serde(default)]
    pub children: Vec<AstSymbol>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AstDocumentSymbolsArgs {
    pub language_id: String,
    pub text: String,
}

pub fn document_symbols(args: AstDocumentSymbolsArgs) -> Result<Vec<AstSymbol>, String> {
    let lang = args.language_id.trim();
    if lang.is_empty() {
        return Err("languageId 为空".to_string());
    }

    let language = match lang {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "javascript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        _ => return Err(format!("AST 暂不支持该语言: {lang}")),
    };

    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&language)
        .map_err(|e| format!("tree-sitter set_language failed: {e}"))?;

    let text = args.text;
    let tree = parser
        .parse(&text, None)
        .ok_or_else(|| "tree-sitter parse failed".to_string())?;

    let root = tree.root_node();
    Ok(collect_symbols(root, &text, lang))
}

fn collect_symbols(node: tree_sitter::Node, src: &str, language_id: &str) -> Vec<AstSymbol> {
    let mut out = Vec::new();
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(mut sym) = symbol_from_node(child, src, language_id) {
            sym.children = collect_symbols(child, src, language_id);
            out.push(sym);
            continue;
        }
        // 非 symbol 节点：继续向下搜索
        out.extend(collect_symbols(child, src, language_id));
    }
    out
}

fn symbol_from_node(
    node: tree_sitter::Node,
    src: &str,
    language_id: &str,
) -> Option<AstSymbol> {
    match language_id {
        "rust" => rust_symbol_from_node(node, src),
        "typescript" | "javascript" | "tsx" => ts_symbol_from_node(node, src),
        _ => None,
    }
}

fn rust_symbol_from_node(node: tree_sitter::Node, src: &str) -> Option<AstSymbol> {
    let kind = node.kind();
    let (sym_kind, name_node) = match kind {
        "function_item" => ("function", node.child_by_field_name("name")),
        "struct_item" => ("struct", node.child_by_field_name("name")),
        "enum_item" => ("enum", node.child_by_field_name("name")),
        "trait_item" => ("trait", node.child_by_field_name("name")),
        "type_item" => ("type", node.child_by_field_name("name")),
        "const_item" => ("const", node.child_by_field_name("name")),
        "static_item" => ("static", node.child_by_field_name("name")),
        "mod_item" => ("module", node.child_by_field_name("name")),
        "macro_definition" => ("macro", node.child_by_field_name("name")),
        // impl_item 没有标准 name；尝试提取第一个 type_identifier 作为展示名
        "impl_item" => ("impl", find_first_type_identifier(node)),
        _ => return None,
    };

    let name_node = name_node?;
    let name = node_text(src, name_node).trim().to_string();
    if name.is_empty() {
        return None;
    }

    Some(AstSymbol {
        name,
        kind: sym_kind.to_string(),
        range: to_range(node),
        selection_range: to_range(name_node),
        children: Vec::new(),
    })
}

fn ts_symbol_from_node(node: tree_sitter::Node, src: &str) -> Option<AstSymbol> {
    let kind = node.kind();
    let (sym_kind, name_node) = match kind {
        "function_declaration" => ("function", node.child_by_field_name("name")),
        "class_declaration" => ("class", node.child_by_field_name("name")),
        "interface_declaration" => ("interface", node.child_by_field_name("name")),
        "type_alias_declaration" => ("type", node.child_by_field_name("name")),
        "enum_declaration" => ("enum", node.child_by_field_name("name")),
        "method_definition" => ("method", node.child_by_field_name("name")),
        _ => return None,
    };

    let name_node = name_node?;
    let name = node_text(src, name_node).trim().to_string();
    if name.is_empty() {
        return None;
    }

    Some(AstSymbol {
        name,
        kind: sym_kind.to_string(),
        range: to_range(node),
        selection_range: to_range(name_node),
        children: Vec::new(),
    })
}

fn find_first_type_identifier(node: tree_sitter::Node) -> Option<tree_sitter::Node> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "type_identifier" {
            return Some(child);
        }
        if let Some(found) = find_first_type_identifier(child) {
            return Some(found);
        }
    }
    None
}

fn node_text<'a>(src: &'a str, node: tree_sitter::Node) -> &'a str {
    let r = node.byte_range();
    src.get(r).unwrap_or("")
}

fn to_range(node: tree_sitter::Node) -> AstRange {
    let start = node.start_position();
    let end = node.end_position();
    AstRange {
        start: AstPosition {
            line: start.row as u32,
            character: start.column as u32,
        },
        end: AstPosition {
            line: end.row as u32,
            character: end.column as u32,
        },
    }
}

