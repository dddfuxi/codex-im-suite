import bpy
import json
import os
import re
import shutil
import sys
import traceback
from datetime import datetime, timezone


def safe_name(value):
    value = re.sub(r"[^a-zA-Z0-9._-]+", "-", value or "asset").strip("-._")
    return value or "asset"


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def unique_path(path):
    base, ext = os.path.splitext(path)
    candidate = path
    index = 1
    while os.path.exists(candidate):
        candidate = f"{base}-{index}{ext}"
        index += 1
    return candidate


def copy_or_save_image(image, target_dir, prefix):
    name = safe_name(image.name)
    source_ext = os.path.splitext(bpy.path.abspath(image.filepath or ""))[1].lower()
    ext = source_ext if source_ext in [".png", ".jpg", ".jpeg", ".webp", ".tga", ".bmp"] else ".png"
    target = unique_path(os.path.join(target_dir, f"{safe_name(prefix)}_{name}{ext}"))

    source = bpy.path.abspath(image.filepath or "")
    if source and os.path.exists(source) and not image.packed_file:
        shutil.copy2(source, target)
        return target

    old_filepath = image.filepath_raw
    old_format = image.file_format
    try:
        image.filepath_raw = target
        image.file_format = "PNG"
        image.save()
        return target
    except Exception:
        try:
            image.save_render(target)
            return target
        finally:
            image.filepath_raw = old_filepath
            image.file_format = old_format


def linked_socket_name(image_node):
    names = []
    for output in image_node.outputs:
        for link in output.links:
            socket = link.to_socket
            if socket:
                names.append(socket.name)
    return ",".join(sorted(set(names)))


def main():
    if "--" not in sys.argv:
        raise RuntimeError("missing -- args")
    source, output_root, model_name = sys.argv[sys.argv.index("--") + 1: sys.argv.index("--") + 4]

    glb_dir = os.path.join(output_root, "glb")
    model_dir = os.path.join(output_root, "unity", "Model")
    textures_dir = os.path.join(output_root, "unity", "Textures")
    materials_dir = os.path.join(output_root, "unity", "Materials")
    for directory in [glb_dir, model_dir, textures_dir, materials_dir]:
        ensure_dir(directory)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.import_scene.gltf(filepath=source)

    for obj in list(bpy.context.scene.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("GLB 导入后没有 Mesh 对象")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        except Exception:
            pass

    material_records = []
    texture_paths = []
    seen_images = set()
    for mat in bpy.data.materials:
        record = {"name": mat.name, "textures": []}
        if mat.use_nodes and mat.node_tree:
            for node in mat.node_tree.nodes:
                if node.type != "TEX_IMAGE" or not node.image:
                    continue
                image = node.image
                key = image.name
                if key not in seen_images:
                    saved = copy_or_save_image(image, textures_dir, mat.name)
                    texture_paths.append(saved)
                    seen_images.add(key)
                else:
                    saved = next((p for p in texture_paths if safe_name(image.name) in os.path.basename(p)), "")
                record["textures"].append({
                    "image": image.name,
                    "file": os.path.relpath(saved, output_root).replace("\\", "/") if saved else "",
                    "usage": linked_socket_name(node),
                })
        material_records.append(record)

    if len(texture_paths) == 0:
        raise RuntimeError("未能从 GLB 中提取到贴图")

    out_glb = os.path.join(glb_dir, f"{model_name}.glb")
    shutil.copy2(source, out_glb)

    out_fbx = os.path.join(model_dir, f"{model_name}.fbx")
    bpy.ops.export_scene.fbx(
        filepath=out_fbx,
        path_mode="COPY",
        embed_textures=False,
        use_selection=False,
        add_leaf_bones=False,
        bake_space_transform=False,
    )

    mat_json = os.path.join(materials_dir, f"{model_name}.mat.json")
    with open(mat_json, "w", encoding="utf-8") as handle:
        json.dump({"materials": material_records}, handle, ensure_ascii=False, indent=2)

    manifest = {
        "sourceFile": source,
        "modelName": model_name,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "glbPath": os.path.relpath(out_glb, output_root).replace("\\", "/"),
        "unityModelPath": os.path.relpath(out_fbx, output_root).replace("\\", "/"),
        "unityImportRoot": f"Assets/External/AI_Generated/{model_name}",
        "textureCount": len(texture_paths),
        "objectCount": len(meshes),
        "materialCount": len(bpy.data.materials),
        "files": [os.path.relpath(p, output_root).replace("\\", "/") for p in [out_glb, out_fbx, mat_json] + texture_paths],
    }
    manifest_path = os.path.join(output_root, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"ok": True, "manifest": manifest}, ensure_ascii=False))


try:
    main()
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc), "trace": traceback.format_exc()}, ensure_ascii=False))
    sys.exit(1)
