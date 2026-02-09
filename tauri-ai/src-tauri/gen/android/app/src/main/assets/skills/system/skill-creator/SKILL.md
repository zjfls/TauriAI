---
name: skill-creator
description: 创建高效 Skill 的指南。当用户想要创建新 Skill（或更新现有 Skill）以使用专业知识、工作流或工具集成来扩展 Codex 能力时，应使用此 Skill。
metadata:
  short-description: 创建或更新 Skill
---

# Skill 创建器

本 Skill 提供创建高效 Skill 的指南。

## 关于 Skill

Skill 是模块化、自包含的包，通过提供专业知识、工作流和工具来扩展 Codex 的能力。将它们视为特定领域或任务的"入职指南"——它们将 Codex 从通用智能体转变为配备程序性知识的专业智能体。

### Skill 提供什么

1. **专业工作流** - 特定领域的多步骤程序
2. **工具集成** - 使用特定文件格式或 API 的说明
3. **领域专业知识** - 公司特定的知识、模式、业务逻辑
4. **捆绑资源** - 用于复杂和重复任务的脚本、参考和资产

## 核心原则

### 简洁是关键

上下文窗口是一种公共资源。Skill 与 Codex 需要的其他所有内容共享上下文窗口：系统提示、对话历史、其他 Skill 的元数据以及实际的用户请求。

**默认假设：Codex 已经非常聪明。** 只添加 Codex 尚未掌握的上下文。质疑每条信息："Codex 真的需要这个解释吗？"以及"这段文字是否值得其令牌成本？"

优先使用简洁的示例而非冗长的解释。

### 设置适当的自由度

将特定级别与任务的脆弱性和可变性相匹配：

**高自由度（基于文本的说明）**：当多种方法都有效、决策取决于上下文或启发式方法指导方法时使用。

**中等自由度（带参数的伪代码或脚本）**：当存在首选模式、可接受一些变化或配置影响行为时使用。

**低自由度（特定脚本，参数少）**：当操作脆弱且容易出错、一致性至关重要或必须遵循特定序列时使用。

将 Codex 视为探索路径：悬崖上的窄桥需要特定的护栏（低自由度），而开阔的田野允许多条路线（高自由度）。

### Skill 的解剖结构

每个 Skill 包含一个必需的 SKILL.md 文件和可选的捆绑资源：

```
skill-name/
├── SKILL.md (必需)
│   ├── YAML 前置元数据 (必需)
│   │   ├── name: (必需)
│   │   └── description: (必需)
│   └── Markdown 说明 (必需)
└── 捆绑资源 (可选)
    ├── scripts/          - 可执行代码 (Python/Bash/等)
    ├── references/       - 根据需要加载到上下文中的文档
    └── assets/           - 在输出中使用的文件（模板、图标、字体等）
```

#### SKILL.md (必需)

每个 SKILL.md 包含：

- **前置数据** (YAML)：包含 `name` 和 `description` 字段。这些是 Codex 读取以确定何时使用 Skill 的唯一字段，因此清晰全面地描述 Skill 是什么以及何时使用它非常重要。
- **正文** (Markdown)：使用 Skill 的说明和指导。仅在 Skill 触发后加载（如果有的话）。

#### 捆绑资源 (可选)

##### 脚本 (`scripts/`)

可执行代码（Python/Bash/等），用于需要确定性可靠性或重复重写的任务。

- **何时包含**：当相同的代码被重复重写或需要确定性可靠性时
- **示例**：用于 PDF 旋转任务的 `scripts/rotate_pdf.py`
- **好处**：令牌高效、确定性、可能无需加载到上下文中即可执行
- **注意**：Codex 可能仍需要读取脚本以进行修补或环境特定的调整

##### 参考资料 (`references/`)

旨在根据需要加载到上下文中以告知 Codex 过程和思考的文档和参考材料。

- **何时包含**：对于 Codex 应在工作时参考的文档
- **示例**：财务模式的 `references/finance.md`、公司 NDA 模板的 `references/mnda.md`、公司政策的 `references/policies.md`、API 规范的 `references/api_docs.md`
- **用例**：数据库模式、API 文档、领域知识、公司政策、详细工作流指南
- **好处**：保持 SKILL.md 精简，仅在 Codex 确定需要时加载
- **最佳实践**：如果文件很大（>10k 字），请在 SKILL.md 中包含 grep 搜索模式
- **避免重复**：信息应存在于 SKILL.md 或参考资料文件中，而不是两者都有。优先使用参考资料文件来存储详细信息，除非它确实是 Skill 的核心——这可以保持 SKILL.md 精简，同时使信息可发现而不会占用上下文窗口。仅在 SKILL.md 中保留基本的程序说明和工作流指导；将详细的参考资料、模式和示例移动到参考资料文件中。

##### 资产 (`assets/`)

不打算加载到上下文中，而是在 Codex 产生的输出中使用的文件。

- **何时包含**：当 Skill 需要将在最终输出中使用的文件时
- **示例**：品牌资产的 `assets/logo.png`、PowerPoint 模板的 `assets/slides.pptx`、HTML/React 样板代码的 `assets/frontend-template/`、字体的 `assets/font.ttf`
- **用例**：模板、图像、图标、样板代码、字体、被复制或修改的示例文档
- **好处**：将输出资源与文档分开，使 Codex 能够使用文件而无需将它们加载到上下文中

#### Skill 中不应包含的内容

Skill 应仅包含直接支持其功能的必要文件。不要创建多余的文档或辅助文件，包括：

- README.md
- INSTALLATION_GUIDE.md
- QUICK_REFERENCE.md
- CHANGELOG.md
- 等等。

Skill 应仅包含 AI 智能体完成手头工作所需的信息。它不应包含关于创建它的过程的辅助上下文、设置和测试程序、面向用户的文档等。创建额外的文档文件只会增加混乱和困惑。

### 渐进式披露设计原则

Skill 使用三级加载系统来有效管理上下文：

1. **元数据（名称 + 描述）** - 始终在上下文中（~100 字）
2. **SKILL.md 正文** - 当 Skill 触发时（<5k 字）
3. **捆绑资源** - 根据需要由 Codex 加载（无限，因为脚本可以在不读入上下文窗口的情况下执行）

#### 渐进式披露模式

保持 SKILL.md 正文精简，少于 500 行以最小化上下文膨胀。接近此限制时将内容拆分为单独的文件。将内容拆分为其他文件时，非常重要的是从 SKILL.md 中引用它们并清楚地描述何时阅读它们，以确保 Skill 的读者知道它们的存在以及何时使用它们。

**关键原则：** 当 Skill 支持多种变体、框架或选项时，仅在 SKILL.md 中保留核心工作流和选择指导。将变体特定的详细信息（模式、示例、配置）移动到单独的参考资料文件中。

**模式 1：带参考资料的高级指南**

```markdown
# PDF 处理

## 快速开始

使用 pdfplumber 提取文本：
[代码示例]

## 高级功能

- **表单填写**：有关完整指南，请参阅 [FORMS.md](FORMS.md)
- **API 参考**：有关所有方法，请参阅 [REFERENCE.md](REFERENCE.md)
- **示例**：有关常见模式，请参阅 [EXAMPLES.md](EXAMPLES.md)
```

Codex 仅在需要时加载 FORMS.md、REFERENCE.md 或 EXAMPLES.md。

**模式 2：按领域组织**

对于具有多个领域的 Skill，按领域组织以避免加载不相关的上下文：

```
bigquery-skill/
├── SKILL.md（概览和导航）
└── reference/
    ├── finance.md（收入、账单指标）
    ├── sales.md（机会、管道）
    ├── product.md（API 使用、功能）
    └── marketing.md（活动、归因）
```

当用户询问销售指标时，Codex 只读取 sales.md。

同样，对于支持多种框架或变体的 Skill，按变体组织：

```
cloud-deploy/
├── SKILL.md（工作流 + 提供商选择）
└── references/
    ├── aws.md（AWS 部署模式）
    ├── gcp.md（GCP 部署模式）
    └── azure.md（Azure 部署模式）
```

当用户选择 AWS 时，Codex 只读取 aws.md。

**模式 3：条件详细信息**

显示基本内容，链接到高级内容：

```markdown
# DOCX 处理

## 创建文档

使用 docx-js 创建新文档。请参阅 [DOCX-JS.md](DOCX-JS.md)。

## 编辑文档

对于简单编辑，直接修改 XML。

**对于修订追踪**：请参阅 [REDLINING.md](REDLINING.md)
**对于 OOXML 详细信息**：请参阅 [OOXML.md](OOXML.md)
```

Codex 仅在用户需要这些功能时读取 REDLINING.md 或 OOXML.md。

**重要指南：**

- **避免深度嵌套的参考资料** - 保持参考资料与 SKILL.md 只有一级深度。所有参考资料文件应直接从 SKILL.md 链接。
- **构建更长的参考资料文件** - 对于超过 100 行的文件，在顶部包含目录，以便 Codex 在预览时可以看到完整的范围。

## Skill 创建过程

Skill 创建涉及以下步骤：

1. 通过具体示例理解 Skill
2. 规划可重用的 Skill 内容（脚本、参考资料、资产）
3. 初始化 Skill（运行 init_skill.py）
4. 编辑 Skill（实现资源并编写 SKILL.md）
5. 打包 Skill（运行 package_skill.py）
6. 根据实际使用进行迭代

按顺序执行这些步骤，除非有明确的理由说明它们不适用，否则不要跳过。

### Skill 命名

- 仅使用小写字母、数字和连字符；将用户提供的标题规范化为连字符格式（例如，"Plan Mode" -> `plan-mode`）。
- 生成名称时，生成少于 64 个字符的名称（字母、数字、连字符）。
- 优先使用描述操作的短动词短语。
- 按工具命名空间，当它可以提高清晰度或触发时（例如，`gh-address-comments`、`linear-address-issue`）。
- 将 Skill 文件夹命名为 Skill 名称。

### 步骤 1：通过具体示例理解 Skill

仅当 Skill 的使用模式已经清楚理解时，才跳过此步骤。即使在使用现有 Skill 时，它仍然很有价值。

要创建有效的 Skill，请清楚地了解 Skill 将如何使用的具体示例。这种理解可以来自直接的用户示例或经过用户反馈验证的生成示例。

例如，在构建 image-editor Skill 时，相关问题包括：

- "image-editor Skill 应该支持什么功能？编辑、旋转，还有其他吗？"
- "你能举一些这个 Skill 如何使用的例子吗？"
- "我可以想象用户会要求'从这张图片中去除红眼'或'旋转这张图片'。你还能想象到这个 Skill 的其他使用方式吗？"
- "用户会说什么来触发这个 Skill？"

为避免让用户不知所措，避免在一条消息中问太多问题。从最重要的问题开始，并根据需要进行跟进，以获得更好的效果。

当对 Skill 应支持的功能有清晰的感觉时，结束此步骤。

### 步骤 2：规划可重用的 Skill 内容

要将具体示例转化为有效的 Skill，请通过以下方式分析每个示例：

1. 考虑如何从头开始执行示例
2. 确定在反复执行这些工作流时哪些脚本、参考资料和资产会有帮助

示例：在构建用于处理"帮我旋转这个 PDF"等查询的 `pdf-editor` Skill 时，分析表明：

1. 旋转 PDF 每次都需要重写相同的代码
2. 在 Skill 中存储 `scripts/rotate_pdf.py` 脚本会很有帮助

示例：在设计用于处理"给我构建一个待办事项应用"或"给我构建一个跟踪我的步数的仪表板"等查询的 `frontend-webapp-builder` Skill 时，分析表明：

1. 编写前端 Web 应用每次都需要相同的样板 HTML/React
2. 包含样板 HTML/React 项目文件的 `assets/hello-world/` 模板会很有帮助

示例：在构建用于处理"今天有多少用户登录？"等查询的 `big-query` Skill 时，分析表明：

1. 查询 BigQuery 每次都需要重新发现表模式和关系
2. 记录表模式的 `references/schema.md` 文件会很有帮助

要建立 Skill 的内容，请分析每个具体示例，以创建要包含的可重用资源列表：脚本、参考资料和资产。

### 步骤 3：初始化 Skill

此时，是时候实际创建 Skill 了。

仅当正在开发的 Skill 已存在且需要迭代或打包时，才跳过此步骤。在这种情况下，继续下一步。

从头开始创建新 Skill 时，始终运行 `init_skill.py` 脚本。该脚本方便地生成一个新的模板 Skill 目录，自动包含 Skill 所需的一切，使 Skill 创建过程更加高效和可靠。

用法：

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]
```

示例：

```bash
scripts/init_skill.py my-skill --path skills/public
scripts/init_skill.py my-skill --path skills/public --resources scripts,references
scripts/init_skill.py my-skill --path skills/public --resources scripts --examples
```

该脚本：

- 在指定路径创建 Skill 目录
- 生成具有正确前置数据和 TODO 占位符的 SKILL.md 模板
- 根据 `--resources` 可选创建资源目录
- 设置 `--examples` 时可选添加示例文件

初始化后，根据需要自定义 SKILL.md 并添加资源。如果使用了 `--examples`，请替换或删除占位符文件。

### 步骤 4：编辑 Skill

编辑（新生成的或现有的）Skill 时，请记住 Skill 是为另一个 Codex 实例创建的。包含对另一个 Codex 有益且非显而易见的信息。考虑哪些程序性知识、领域特定的详细信息或可重用资产可以帮助另一个 Codex 实例更有效地执行这些任务。

#### 学习经过验证的设计模式

根据 Skill 的需求查阅这些有用的指南：

- **多步骤过程**：有关顺序工作流和条件逻辑，请参阅 references/workflows.md
- **特定输出格式或质量标准**：有关模板和示例模式，请参阅 references/output-patterns.md

这些文件包含有效 Skill 设计的既定最佳实践。

#### 从可重用的 Skill 内容开始

要开始实现，请从上面确定的可重用资源开始：`scripts/`、`references/` 和 `assets/` 文件。请注意，此步骤可能需要用户输入。例如，在实现 `brand-guidelines` Skill 时，用户可能需要提供要存储在 `assets/` 中的品牌资产或模板，或要存储在 `references/` 中的文档。

必须通过实际运行来测试添加的脚本，以确保没有错误并且输出符合预期。如果有很多类似的脚本，只需要测试一个有代表性的样本，以确保它们都有效，同时平衡完成时间。

如果使用了 `--examples`，请删除 Skill 不需要的任何占位符文件。仅创建实际需要的资源目录。

#### 更新 SKILL.md

**写作指南：** 始终使用命令式/不定式形式。

##### 前置数据

编写带有 `name` 和 `description` 的 YAML 前置数据：

- `name`：Skill 名称
- `description`：这是 Skill 的主要触发机制，帮助 Codex 理解何时使用 Skill。
  - 包括 Skill 做什么以及何时使用它的具体触发器/上下文。
  - 在此处包含所有"何时使用"信息——而不是正文中。正文仅在触发后加载，因此正文中的"何时使用此 Skill"部分对 Codex 没有帮助。
  - Skill 的 `docx` 描述示例："使用 Codex 处理专业文档（.docx 文件）时的综合文档创建、编辑和分析，支持修订追踪、评论、格式保留和文本提取。用于：(1) 创建新文档，(2) 修改或编辑内容，(3) 使用修订追踪，(4) 添加评论，或任何其他文档任务"

不要在 YAML 前置数据中包含任何其他字段。

##### 正文

编写使用 Skill 及其捆绑资源的说明。

### 步骤 5：打包 Skill

一旦 Skill 的开发完成，必须将其打包成可分发的 .skill 文件，与用户共享。打包过程首先自动验证 Skill，以确保它满足所有要求：

```bash
scripts/package_skill.py <path/to/skill-folder>
```

可选的输出目录规范：

```bash
scripts/package_skill.py <path/to/skill-folder> ./dist
```

打包脚本将：

1. **验证** Skill，检查：

   - YAML 前置数据格式和必填字段
   - Skill 命名约定和目录结构
   - 描述完整性和质量
   - 文件组织和资源引用

2. 如果验证通过，**打包** Skill，创建一个以 Skill 命名的 .skill 文件（例如，`my-skill.skill`），该文件包含所有文件并保持正确的目录结构以进行分发。.skill 文件是一个带有 .skill 扩展名的 zip 文件。

如果验证失败，脚本将报告错误并退出而不创建包。修复任何验证错误并再次运行打包命令。

### 步骤 6：迭代

测试 Skill 后，用户可能会请求改进。通常这发生在使用 Skill 之后，对 Skill 的表现有新鲜的背景。

**迭代工作流：**

1. 在实际任务中使用 Skill
2. 注意困难或低效之处
3. 确定应如何更新 SKILL.md 或捆绑资源
4. 实施更改并再次测试
