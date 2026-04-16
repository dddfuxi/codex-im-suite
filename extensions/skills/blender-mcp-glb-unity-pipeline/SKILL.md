---
name: blender-mcp-glb-unity-pipeline
description: 使用 Blender MCP 处理 AI 生成的 GLB/GLTF 资产，按统一格式导出带贴图的 GLB 包，并一键整理成可导入 Unity 的资源目录。适用于用户提到 Blender MCP、GLB、glTF、AI 模型、导出贴图、导入 Unity、统一格式、资产清洗时。
---

# Blender MCP GLB Unity Pipeline

这个 skill 用来把 AI 生成的 `.glb/.gltf` 资产收口成统一的导出格式，并顺手生成一份适合 Unity 导入的包。

## 什么时候用

出现这些需求时使用：

- “把这个 GLB 导出成统一格式”
- “AI 生成模型贴图乱了，整理一下再导出”
- “从 Blender 一键导入 Unity”
- “把这个 GLB 规范化，后续给 Unity 用”
- “需要保留贴图并输出稳定目录结构”

## 默认前提

- Blender MCP 已连接。
- 输入源通常是 `.glb` 或 `.gltf`，例如 `C:\Users\admin\Downloads\wrS7y4.glb`。
- Unity 默认工程优先使用 `C:\unity\ST3\Game`。
- 如果用户没有指定导出目录，默认在源文件同级生成：
  - `<模型名>_export`

## 工作目标

1. 先把 AI 生成的 GLB 导入 Blender。
2. 清理常见脏结构：
   - 多余空节点
   - 未使用材质
   - 丢失贴图引用
   - 不合理缩放/旋转
   - 多余灯光/相机
3. 统一导出两套产物：
   - 一套“带贴图的 GLB 包”
   - 一套“Unity 可导入包”
4. 如果用户要求一键导入 Unity，就把 Unity 包直接放进目标工程，并在可能时触发 Unity 侧刷新。

## 执行规则

### 1. 先探测 Blender MCP 当前能力

不要假设某个命令名一定存在。先确认当前 Blender MCP 暴露了哪些导入、导出、对象清理相关能力，再执行。

如果当前 MCP 没有足够的导入/导出能力：

- 明确说出缺的能力是什么
- 停止伪造成功
- 不要假装已经导出了文件

### 2. 导入输入模型

输入优先接受：

- `.glb`
- `.gltf`

导入后要先检查：

- 是否真的有 mesh 对象
- 是否有材质
- 是否有图片贴图
- 层级里是否存在明显多余的空节点包装

### 3. 清理和规范化

默认按下面的规则整理：

- 保留主 mesh 和必要骨骼
- 删除多余相机、灯光、测试物体
- 尽量把导出根节点收口到单一可识别名称
- 如果对象缩放明显异常，应用变换并统一尺度
- 优先保留基于 Principled BSDF 的材质结构
- 修复图片纹理节点到基础颜色、法线、粗糙度、金属度、发光、透明度的常见连接
- 丢失贴图时明确报错，不要静默继续

### 4. 统一导出格式

完整格式在 [default-format.md](./references/default-format.md)。

默认输出目录结构：

```text
<模型名>_export/
  glb/
    <模型名>.glb
  unity/
    Model/
      <模型名>.fbx
    Textures/
      ...
    Materials/
      ...
  manifest.json
```

要求：

- `glb/<模型名>.glb` 必须包含贴图，优先导出成自包含交付物。
- Unity 包默认导出 `FBX + 贴图目录 + 材质目录`，避免把 Unity 导入成功与否绑死在项目是否装了 glTF 插件。
- `manifest.json` 必须记录来源文件、导出时间、贴图数量、对象数量、默认 Unity 导入路径。

### 5. 一键导入 Unity

如果用户要求导入 Unity：

1. 先确定 Unity 工程路径，默认：
   - `C:\unity\ST3\Game`
2. 使用：
   - [copy-package-to-unity.ps1](./scripts/copy-package-to-unity.ps1)
3. 默认导入到：
   - `Assets\External\AI_Generated\<模型名>`
4. 如果 Unity MCP 可用，再做一次资源刷新或导入验证。
5. 如果 Unity MCP 不可用，至少明确告知文件已经拷贝到哪个 Unity 目录。

## 输出要求

最终回复只保留结果，不要把完整思考过程都发给用户。至少要包含：

- 输入文件路径
- 导出目录
- GLB 输出路径
- Unity 包输出路径
- 如果已导入 Unity，则给出 Unity 工程路径和目标 Assets 路径
- 如果失败，则给出明确失败点

## 禁止事项

- 不要把 Scene View 截图、面板日志、长过程描述当成结果。
- 不要只导出 GLB 然后谎称“Unity 已可用”。
- 不要把旧会话里的别的模型路径混进当前任务。
- 不要擅自改到非授权 Unity 工程。
- 不要在贴图丢失时继续产出“看起来成功”的包。

## 辅助脚本

把导出包复制进 Unity 时使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\copy-package-to-unity.ps1 -PackageRoot "<导出目录>" -UnityProjectPath "C:\unity\ST3\Game"
```
