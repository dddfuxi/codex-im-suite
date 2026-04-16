# 默认导出格式

这个 skill 的默认交付格式固定如下。

## 目录结构

```text
<模型名>_export/
  glb/
    <模型名>.glb
  unity/
    Model/
      <模型名>.fbx
    Textures/
      BaseColor.png
      Normal.png
      Roughness.png
      Metallic.png
      Emission.png
      Opacity.png
    Materials/
      <模型名>.mat.json
  manifest.json
```

## 说明

- `glb/<模型名>.glb`
  - 面向归档、回传、再次导入 Blender。
  - 需要是完整可交付文件。
  - 默认要求带贴图。

- `unity/Model/<模型名>.fbx`
  - 面向 Unity 原生导入。
  - 作为 Unity 主模型文件。

- `unity/Textures/`
  - 放所有实际引用的贴图。
  - 文件名尽量稳定，不用随机名。

- `unity/Materials/<模型名>.mat.json`
  - 不是 Unity 原生 `.mat`。
  - 这里仅作为材质映射清单，记录每个材质槽对应哪些贴图。
  - 真正 Unity 材质仍由 Unity 工程内生成或手动调整。

- `manifest.json`
  - 记录导出元信息。

## manifest.json 最小字段

```json
{
  "sourceFile": "C:\\Users\\admin\\Downloads\\wrS7y4.glb",
  "modelName": "wrS7y4",
  "exportedAt": "2026-04-16T14:00:00+08:00",
  "glbPath": "glb/wrS7y4.glb",
  "unityModelPath": "unity/Model/wrS7y4.fbx",
  "unityImportRoot": "Assets/External/AI_Generated/wrS7y4",
  "textureCount": 6,
  "objectCount": 1,
  "materialCount": 1
}
```

## Unity 导入约定

默认把整个包导入到：

```text
Assets/External/AI_Generated/<模型名>/
  SourceGLB/
  Model/
  Textures/
  Materials/
  manifest.json
```

其中：

- `SourceGLB/` 保存标准 GLB 交付物
- `Model/` 保存 Unity 主模型文件
- `Textures/` 保存贴图
- `Materials/` 保存映射清单

## 覆盖规则

- 同名模型再次导入时默认覆盖旧文件
- 但不要清空整个 `AI_Generated` 根目录
- 只覆盖当前模型对应目录
