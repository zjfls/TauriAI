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
        "python" => tree_sitter_python::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "c" => tree_sitter_c::LANGUAGE.into(),
        "cpp" => tree_sitter_cpp::LANGUAGE.into(),
        "lua" => tree_sitter_lua::LANGUAGE.into(),
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

fn symbol_from_node(node: tree_sitter::Node, src: &str, language_id: &str) -> Option<AstSymbol> {
    match language_id {
        "rust" => rust_symbol_from_node(node, src),
        "typescript" | "javascript" | "tsx" => ts_symbol_from_node(node, src),
        "python" => python_symbol_from_node(node, src),
        "go" => go_symbol_from_node(node, src),
        "c" | "cpp" => c_like_symbol_from_node(node, src, language_id),
        "lua" => lua_symbol_from_node(node, src),
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

fn python_symbol_from_node(node: tree_sitter::Node, src: &str) -> Option<AstSymbol> {
    let kind = node.kind();
    let (sym_kind, name_node) = match kind {
        "function_definition" => ("function", node.child_by_field_name("name")),
        "class_definition" => ("class", node.child_by_field_name("name")),
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

fn go_symbol_from_node(node: tree_sitter::Node, src: &str) -> Option<AstSymbol> {
    let kind = node.kind();
    let (sym_kind, name_node) = match kind {
        "function_declaration" => ("function", node.child_by_field_name("name")),
        "method_declaration" => ("method", node.child_by_field_name("name")),
        "type_spec" => {
            let type_node_kind = node
                .child_by_field_name("type")
                .map(|t| t.kind().to_string())
                .unwrap_or_default();
            let sym_kind = match type_node_kind.as_str() {
                "struct_type" => "struct",
                "interface_type" => "interface",
                _ => "type",
            };
            (sym_kind, node.child_by_field_name("name"))
        }
        // Struct fields / interface methods (best-effort, keep outline useful).
        "field_declaration" => (
            "field",
            node.child_by_field_name("name")
                .and_then(find_first_go_identifier_like)
                .or_else(|| find_first_go_identifier_like(node)),
        ),
        "method_spec" => (
            "method",
            node.child_by_field_name("name")
                .or_else(|| find_first_go_identifier_like(node)),
        ),
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

fn c_like_symbol_from_node(
    node: tree_sitter::Node,
    src: &str,
    language_id: &str,
) -> Option<AstSymbol> {
    let kind = node.kind();

    let (sym_kind, name_node) = match kind {
        "function_definition" => (
            "function",
            find_first_identifier_in_field(node, "declarator"),
        ),
        "struct_specifier" => (
            "struct",
            node.child_by_field_name("name")
                .or_else(|| find_first_type_identifier(node)),
        ),
        "enum_specifier" => (
            "enum",
            node.child_by_field_name("name")
                .or_else(|| find_first_type_identifier(node)),
        ),
        // C++ only
        "class_specifier" if language_id == "cpp" => (
            "class",
            node.child_by_field_name("name")
                .or_else(|| find_first_type_identifier(node)),
        ),
        "namespace_definition" if language_id == "cpp" => {
            ("namespace", node.child_by_field_name("name"))
        }
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

fn lua_symbol_from_node(node: tree_sitter::Node, src: &str) -> Option<AstSymbol> {
    let kind = node.kind();

    // tree-sitter-lua 的节点命名在不同版本/方言可能略有差异；这里做 best-effort 识别：
    // - function_declaration / function_definition / local_function / function_statement
    // - assignment 里形如 `foo = function() end`（可能需要更深解析，这里只覆盖常见声明）
    let (sym_kind, name_node) = match kind {
        "function_declaration"
        | "function_definition"
        | "local_function"
        | "function_statement" => (
            "function",
            node.child_by_field_name("name")
                .or_else(|| find_first_identifier(node)),
        ),
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

fn find_first_go_identifier_like<'a>(node: tree_sitter::Node<'a>) -> Option<tree_sitter::Node<'a>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "identifier" | "field_identifier" | "type_identifier" => return Some(child),
            _ => {}
        }
        if let Some(found) = find_first_go_identifier_like(child) {
            return Some(found);
        }
    }
    None
}

fn find_first_type_identifier<'a>(node: tree_sitter::Node<'a>) -> Option<tree_sitter::Node<'a>> {
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

fn find_first_identifier<'a>(node: tree_sitter::Node<'a>) -> Option<tree_sitter::Node<'a>> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "identifier" {
            return Some(child);
        }
        if let Some(found) = find_first_identifier(child) {
            return Some(found);
        }
    }
    None
}

fn find_first_identifier_in_field<'a>(
    node: tree_sitter::Node<'a>,
    field: &str,
) -> Option<tree_sitter::Node<'a>> {
    let target = node.child_by_field_name(field)?;
    find_first_identifier(target)
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
