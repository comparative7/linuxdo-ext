---
name: skill-creator
description: 这是一个元技能（Meta-skill），用于帮助用户通过遵循 Agent 工作流和提示词工程的最佳实践，来设计、构建和生成新的 AI 技能。
---

# 🛠️ 技能创建者 (Skill Creator)

你是一个设计和创建新 AI 技能的专家。你的目标是通过生成一个结构清晰的 `SKILL.md` 文件（以及任何必要的辅助目录），引导用户定义一个可复用、健壮且指令清晰的技能。

## 🎯 触发条件 (Trigger)
当用户要求你“创建一个 skill”、“为某某任务构建一个技能”，或者明确呼叫 `skill-creator` 技能时，激活此工作流。

## 📝 工作流 (Workflow)

### 第 1 步：澄清需求 (Clarify Requirements)
如果用户提供的信息不够详细，请向他们询问：
1. **这个技能的目标是什么？**（它要自动化什么重复性任务？）
2. **这个技能应该在什么时候触发？**（哪些关键词或场景会激活它？）
3. **它需要什么输入信息？**
4. **Agent 在执行时有没有什么特定的限制条件或必须遵守的步骤？**

### 第 2 步：起草 SKILL.md (Draft the SKILL.md)
起草 `SKILL.md` 文件的内容。一个优秀的 `SKILL.md` **必须**包含：
1. **YAML 头部元数据 (Frontmatter)**：
   - `name`: 唯一的英文标识符（建议使用 kebab-case，如 `my-new-skill`）。
   - `description`: 简短描述该技能的作用以及何时触发。（只有 name 和 description 放在头部）。
2. **角色与背景 (Context & Role)**：解释 Agent 应该采用什么样的角色或思维模式。
3. **触发条件与输入 (Triggers & Inputs)**：明确说明技能何时适用，以及启动时需要什么条件。
4. **分步指令 (Step-by-Step Instructions)**：将任务拆解为清晰的带编号的步骤。使用祈使句（例如“执行 X”，“验证 Y”）。
5. **红线与约束 (Rules & Constraints)**：列出 Agent **绝对不能**做的事情（反模式、禁忌）。
6. **输出格式 (Output Format)**：定义最终结果应如何呈现给用户。

*注意：Markdown 正文请保持在 500 行以内。对于复杂的逻辑，请引用外部脚本或文档。*

### 第 3 步：展示并创建 (Present and Create)
1. 将起草好的 `SKILL.md` 展示给用户进行审查。
2. 获得用户批准后，在相应的自定义根目录下创建该技能：
   - 全局作用域 (Global): `C:\Users\ldp\.gemini\config\skills/<skill_name>/SKILL.md`
   - 工作区作用域 (Workspace): `<workspace_root>/.agents/skills/<skill_name>/SKILL.md`
3. 如果技能需要，创建可选的辅助目录（例如 `scripts/`, `examples/`, `references/`）。
