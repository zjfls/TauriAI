---
name: skill-installer
description: 从精选列表或 GitHub 仓库路径将 Codex Skill 安装到 $CODEX_HOME/skills。当用户要求列出可安装的 Skill、安装精选 Skill 或从其他仓库（包括私有仓库）安装 Skill 时使用。
metadata:
  short-description: 从 openai/skills 或其他仓库安装精选 Skill
---

# Skill 安装器

帮助安装 Skill。默认情况下，这些来自 https://github.com/openai/skills/tree/main/skills/.curated，但用户也可以提供其他位置。

根据任务使用辅助脚本：
- 当用户询问有哪些可用时，或如果用户在没有指定要做什么的情况下使用此 Skill 时，列出精选 Skill。
- 当用户提供 Skill 名称时，从精选列表安装。
- 当用户提供 GitHub 仓库/路径（包括私有仓库）时，从其他仓库安装。

使用辅助脚本安装 Skill。

## 通信

列出精选 Skill 时，根据用户请求的上下文大致如下输出：
"""
来自 {repo} 的 Skill：
1. skill-1
2. skill-2（已安装）
3. ...
你想安装哪些？
"""

安装 Skill 后，告诉用户："重新启动 Codex 以获取新的 Skill。"

## 脚本

所有这些脚本都使用网络，因此在沙盒中运行时，运行它们时请请求升级。

- `scripts/list-curated-skills.py`（打印带有已安装注释的精选列表）
- `scripts/list-curated-skills.py --format json`
- `scripts/install-skill-from-github.py --repo <owner>/<repo> --path <path/to/skill> [<path/to/skill> ...]`
- `scripts/install-skill-from-github.py --url https://github.com/<owner>/<repo>/tree/<ref>/<path>`

## 行为和选项

- 默认为公共 GitHub 仓库的直接下载。
- 如果下载因认证/权限错误而失败，则回退到 git 稀疏检出。
- 如果目标 Skill 目录已存在，则中止。
- 安装到 `$CODEX_HOME/skills/<skill-name>`（默认为 `~/.codex/skills`）。
- 多个 `--path` 值在一次运行中安装多个 Skill，每个 Skill 都从路径基本名称命名，除非提供 `--name`。
- 选项：`--ref <ref>`（默认 `main`）、`--dest <path>`、`--method auto|download|git`。

## 注意事项

- 精选列表通过 GitHub API 从 `https://github.com/openai/skills/tree/main/skills/.curated` 获取。如果不可用，请解释错误并退出。
- 私有 GitHub 仓库可以通过现有的 git 凭据或可选的 `GITHUB_TOKEN`/`GH_TOKEN` 进行下载访问。
- Git 回退首先尝试 HTTPS，然后尝试 SSH。
- https://github.com/openai/skills/tree/main/skills/.system 处的 Skill 是预安装的，因此无需帮助用户安装这些。如果他们询问，只需解释这一点。如果他们坚持，你可以下载并覆盖。
- 已安装注释来自 `$CODEX_HOME/skills`。
