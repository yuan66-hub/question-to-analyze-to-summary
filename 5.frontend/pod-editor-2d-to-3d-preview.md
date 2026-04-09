# POD 编辑器实现原理：从 2D 画布到 3D 模型预览

## 概述

POD（Print on Demand）编辑器是在线图形设计工具，允许用户在商品（T恤、马克杯、海报等）上自定义设计。核心技术链路为：**Canvas 2D 编辑 → 纹理导出 → 3D 模型加载 → UV 贴图映射 → 实时渲染预览**。

## 整体架构

```
┌─────────────────────────────────────────────────┐
│                  UI Layer                        │
│  工具栏 / 属性面板 / 图层面板 / 资源面板         │
├─────────────────────────────────────────────────┤
│               Canvas Engine                      │
│  渲染引擎 / 事件系统 / 变换系统 / 历史栈         │
├─────────────────────────────────────────────────┤
│              Data Model Layer                    │
│  场景树 / 序列化 / 约束系统 / 模板系统           │
├─────────────────────────────────────────────────┤
│              Service Layer                       │
│  导出服务 / 字体服务 / 图片服务 / 协同服务       │
└─────────────────────────────────────────────────┘
```

## 技术栈总览

| 层级 | 技术选型 |
|------|---------|
| 框架层 | React / Vue 3 + TypeScript |
| 状态管理 | Zustand / Pinia / MobX |
| Canvas 引擎 | Fabric.js（主流）/ Konva.js / PixiJS |
| 3D 预览 | Three.js / Babylon.js |
| 字体处理 | opentype.js / FontFace API |
| 图片处理 | WebGL Shaders / ONNX Runtime |
| 历史记录 | Immer.js + Command Pattern |
| 构建工具 | Vite / Webpack |

---

## 一、Canvas 渲染引擎

### 技术选型对比

| 方案 | 库 | 适用场景 |
|------|-----|---------|
| Canvas 2D | Fabric.js、Konva.js | 主流方案，生态成熟 |
| WebGL | PixiJS、Three.js | 高性能、3D 预览 |
| SVG | Snap.svg、Paper.js | 矢量编辑为主 |
| 混合方案 | Fabric.js + Three.js | 2D 编辑 + 3D 预览 |

### 渲染循环

```
requestAnimationFrame → 清空画布 → 遍历场景树 → 逐层绘制 → 绘制控制点
```

Fabric.js 提供完整的对象模型（Rect、Text、Image、Group、Path）、内置交互（选中、拖拽、缩放、旋转）、序列化/反序列化（`toJSON()` / `loadFromJSON()`）及滤镜系统。

---

## 二、核心功能模块

### 2.1 对象变换系统

```
Transform Matrix: [scaleX, skewY, skewX, scaleY, translateX, translateY]

拖拽 → 修改 translate
缩放 → 修改 scale（角控制点）
旋转 → 修改 rotation（旋转控制点）
翻转 → scale 取负值
```

涉及仿射变换/矩阵运算、碰撞检测（Bounding Box / Point-in-Polygon）、控制点命中测试。

### 2.2 文字编辑

| 功能 | 技术 |
|------|------|
| 富文本编辑 | Canvas 文字测量 + 自研排版引擎 |
| 字体加载 | FontFace API / opentype.js |
| 弧形文字 | 沿 Path 逐字符绘制（贝塞尔曲线） |
| 文字描边/阴影 | Canvas strokeText + shadowBlur |
| 字体子集化 | fonttools / fontmin |

### 2.3 图片处理

| 功能 | 技术 |
|------|------|
| 滤镜 | Canvas ImageData 像素操作 / WebGL Shader |
| 抠图 | remove.bg API / ONNX Runtime (U²-Net) |
| 裁剪 | clipPath 蒙版裁剪 |
| SVG 解析 | DOMParser + 路径数据解析 |

### 2.4 历史记录（Undo/Redo）

```
Command Pattern:
execute() → 入栈 undoStack，清空 redoStack
undo()    → 出栈 undoStack，入栈 redoStack
redo()    → 出栈 redoStack，入栈 undoStack
```

优化策略：大型项目使用增量 diff-patch 代替全量快照。

### 2.5 图层与对齐

场景树结构：Background Layer（锁定）→ Design Layer（多对象按 z-index 排列）→ Safe Zone Layer（辅助线）。

智能对齐线通过遍历对象边界 + 吸附阈值判断实现，安全区域通过 clipPath / 半透明遮罩层表示。

---

## 三、2D 画布导出为纹理（关键步骤一）

将 Fabric.js 画布内容导出为高分辨率图像，供 Three.js 作为贴图使用：

```ts
class DesignExporter {
  private fabricCanvas: fabric.Canvas;

  // 导出设计区域为纹理图（multiplier 提高分辨率，印刷级通常 4x）
  exportAsTexture(options?: { multiplier?: number }): HTMLCanvasElement {
    const { multiplier = 2 } = options || {};

    // 隐藏辅助元素（安全线、网格、控制点）
    const helperObjects = this.fabricCanvas.getObjects().filter(
      obj => obj.data?.type === 'helper'
    );
    helperObjects.forEach(obj => (obj.visible = false));

    // 隐藏产品底图，只保留用户设计
    const background = this.fabricCanvas.backgroundImage;
    this.fabricCanvas.backgroundImage = null;

    // 导出为离屏 Canvas（保持透明背景）
    const textureCanvas = this.fabricCanvas.toCanvasElement(multiplier, {
      left: this.designArea.left,
      top: this.designArea.top,
      width: this.designArea.width,
      height: this.designArea.height,
    });

    // 恢复隐藏的元素
    this.fabricCanvas.backgroundImage = background;
    helperObjects.forEach(obj => (obj.visible = true));
    this.fabricCanvas.renderAll();

    return textureCanvas;
  }

  // 实时同步：Fabric.js 每次修改后通知 3D 场景更新纹理
  setupRealtimeSync(update3DTexture: (canvas: HTMLCanvasElement) => void) {
    const debouncedUpdate = debounce(() => {
      const tex = this.exportAsTexture();
      update3DTexture(tex);
    }, 16); // ~60fps

    this.fabricCanvas.on('after:render', debouncedUpdate);
  }
}
```

---

## 四、加载 3D 模型（关键步骤二）

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

class ProductViewer3D {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private productMesh: THREE.Mesh;

  constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      45, container.clientWidth / container.clientHeight, 0.1, 100
    );
    this.camera.position.set(0, 0.5, 2.5);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    // 轨道控制器（鼠标旋转/缩放）
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // 环境光照 HDR（让产品有真实反射）
    new RGBELoader().load('/envmaps/studio.hdr', (hdrTexture) => {
      hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = hdrTexture;
    });

    this.animate();
  }

  // 加载产品模型，约定设计区域 mesh 命名为 "DesignArea"
  async loadProduct(modelUrl: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(modelUrl);
    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        if (child.name === 'DesignArea') this.productMesh = child;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.scene.add(gltf.scene);
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
```

---

## 五、UV 贴图映射（核心原理）

### UV 映射原理

```
UV 坐标系 (0,0)~(1,1)           3D 模型表面
┌──────────────────┐            ╭─────────────╮
│ (0,1)     (1,1)  │            │  设计图被   │
│                   │   映射 →   │  "包裹"在   │
│   设计图纹理      │            │  模型曲面上  │
│ (0,0)     (1,0)  │            ╰─────────────╯
└──────────────────┘

每个顶点有 (x,y,z) 坐标和 (u,v) 纹理坐标
GPU 根据 UV 自动插值采样纹理像素
```

### 实现代码

```ts
class TextureMapper {
  // 将 2D Canvas 设计应用到 3D 模型材质上
  applyDesignToModel(
    mesh: THREE.Mesh,
    designCanvas: HTMLCanvasElement,
    options?: { repeat?: THREE.Vector2; offset?: THREE.Vector2 }
  ): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(designCanvas);
    texture.flipY = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 16;          // 各向异性过滤（斜视角清晰度）
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;

    // 构建 PBR 材质
    mesh.material = new THREE.MeshStandardMaterial({
      map: texture,              // 漫反射贴图（设计图）
      roughness: 0.8,            // 粗糙度（棉布 T 恤约 0.8）
      metalness: 0.0,            // 金属度（织物为 0）
      normalMap: this.fabricNormalMap,  // 布料法线贴图
      normalScale: new THREE.Vector2(0.3, 0.3),
      transparent: true,
      side: THREE.FrontSide,
    });

    return texture;
  }

  // 实时更新纹理（不重建 texture 对象，只更新 source）
  updateTexture(texture: THREE.CanvasTexture, newCanvas: HTMLCanvasElement) {
    texture.image = newCanvas;
    texture.needsUpdate = true; // 通知 GPU 重新上传纹理数据
  }
}
```

---

## 六、Blender UV 展开（模型制作侧）

UV 展开决定设计图如何"铺"在模型表面，是建模阶段的工作：

```python
# Blender Python 脚本：自动 UV 展开 T恤正面区域
import bpy, bmesh

obj = bpy.context.active_object
bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(obj.data)

# 选择正面朝观众的面（法线方向 -Y）
for face in bm.faces:
    face.select = face.normal.y < -0.5

# 从正面视角投影展开
bpy.ops.uv.project_from_view(camera_bounds=False, scale_to_bounds=True)
bpy.ops.uv.pack_islands(margin=0.01)

bmesh.update_edit_mesh(obj.data)
bpy.ops.object.mode_set(mode='OBJECT')

# 导出 GLB（必须包含 UV 数据）
bpy.ops.export_scene.gltf(
    filepath='/output/tshirt.glb',
    export_format='GLB',
    export_texcoords=True,
)
```

---

## 七、高级：设计区域蒙版（局部贴图）

POD 产品通常只在特定区域（胸口、背部）可以印花，需要蒙版控制设计图只出现在指定区域：

```ts
class MaskedTextureMapper {
  createMaskedMaterial(
    designCanvas: HTMLCanvasElement,
    maskUrl: string,       // 灰度蒙版图：白色=可印区域，黑色=不可印
    baseColor: THREE.Color // 产品底色
  ): THREE.ShaderMaterial {
    const designTexture = new THREE.CanvasTexture(designCanvas);
    const maskTexture = new THREE.TextureLoader().load(maskUrl);

    return new THREE.ShaderMaterial({
      uniforms: {
        uDesignMap: { value: designTexture },
        uMaskMap: { value: maskTexture },
        uBaseColor: { value: baseColor },
        uDesignOpacity: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uDesignMap;
        uniform sampler2D uMaskMap;
        uniform vec3 uBaseColor;
        uniform float uDesignOpacity;
        varying vec2 vUv;

        void main() {
          vec4 design = texture2D(uDesignMap, vUv);
          float mask = texture2D(uMaskMap, vUv).r;

          // 蒙版白色区域显示设计图，黑色区域显示产品底色
          vec3 finalColor = mix(
            uBaseColor,
            design.rgb,
            design.a * mask * uDesignOpacity
          );
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
    });
  }
}
```

---

## 八、曲面贴合（马克杯等圆柱产品）

```ts
class CylindricalMapper {
  // 将设计图按圆柱投影映射：θ 角度 → U，高度 → V
  applyCylindricalUV(geometry: THREE.BufferGeometry, arcAngle = Math.PI) {
    const positions = geometry.attributes.position;
    const uvs = new Float32Array(positions.count * 2);

    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);

      const theta = Math.atan2(x, z);
      const u = (theta + arcAngle / 2) / arcAngle;
      const v = (y - this.minY) / (this.maxY - this.minY);

      uvs[i * 2] = THREE.MathUtils.clamp(u, 0, 1);
      uvs[i * 2 + 1] = v;
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  }

  // 置换贴图：设计图在布料表面有微凸效果（丝印/刺绣质感）
  addPrintRelief(mesh: THREE.Mesh, designCanvas: HTMLCanvasElement) {
    const displacementTexture = new THREE.CanvasTexture(
      this.convertToGrayscale(designCanvas)
    );
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.displacementMap = displacementTexture;
    mat.displacementScale = 0.002;
  }
}
```

---

## 九、完整集成

```ts
class PODEditor {
  private exporter: DesignExporter;
  private viewer: ProductViewer3D;
  private mapper: TextureMapper;
  private activeTexture: THREE.CanvasTexture | null = null;

  async init(fabricCanvas: fabric.Canvas, container3D: HTMLElement) {
    this.exporter = new DesignExporter(fabricCanvas);
    this.viewer = new ProductViewer3D(container3D);
    this.mapper = new TextureMapper(this.viewer.renderer);

    // 1. 加载产品 3D 模型
    await this.viewer.loadProduct('/models/tshirt.glb');

    // 2. 初次贴图
    const designCanvas = this.exporter.exportAsTexture({ multiplier: 2 });
    this.activeTexture = this.mapper.applyDesignToModel(
      this.viewer.productMesh, designCanvas
    );

    // 3. 实时同步：Fabric.js 编辑 → 3D 预览即时更新
    this.exporter.setupRealtimeSync((updatedCanvas) => {
      this.mapper.updateTexture(this.activeTexture!, updatedCanvas);
    });
  }

  changeProductColor(hex: string) {
    const mat = this.viewer.baseMesh.material as THREE.MeshStandardMaterial;
    mat.color.set(hex);
  }

  capturePreview(): string {
    this.viewer.renderer.render(this.viewer.scene, this.viewer.camera);
    return this.viewer.renderer.domElement.toDataURL('image/png');
  }
}
```

---

## 十、导出与印刷

| 环节 | 技术 |
|------|------|
| 高清导出 | Canvas `toDataURL` / `toBlob`（乘以 DPI 倍率） |
| PDF 生成 | jsPDF / PDFKit (Node.js) |
| SVG 导出 | 对象序列化为 SVG 标签 |
| CMYK 转换 | 服务端 ImageMagick / Sharp + ICC Profile |
| 分辨率校验 | 前端计算 DPI = px / (物理尺寸 inch) |

---

## 十一、关键难点与方案

| 难点 | 解决方案 |
|------|----------|
| 大量对象性能 | 虚拟化渲染 / 离屏 Canvas / WebGL 加速 |
| 印刷级精度 | 物理单位换算（px↔mm↔inch）、300 DPI 导出 |
| 字体版权 | 字体授权管理 + 子集化减小体积 |
| 颜色一致性 | ICC 色彩管理、RGB→CMYK 服务端转换 |
| 移动端适配 | 手势识别（Hammer.js）、虚拟键盘处理 |
| 协同编辑 | CRDT（Yjs）/ OT 算法 |
| 纹理实时同步 | `texture.needsUpdate` + debounce 16ms |
| 曲面贴合 | 圆柱/球面投影 UV + displacement map |

---

## 技术关键点总结

| 环节 | 关键技术 |
|------|---------|
| 2D 导出 | `fabric.toCanvasElement()` 离屏渲染 |
| 纹理创建 | `THREE.CanvasTexture` + anisotropy |
| UV 映射 | 模型预制 UV (Blender) + `BufferAttribute` |
| 材质混合 | `ShaderMaterial` + 蒙版 alphaMap |
| 实时同步 | `texture.needsUpdate` + debounce |
| 曲面贴合 | 圆柱/球面投影 UV + displacement map |
| 环境光照 | HDR 环境贴图 + PBR 材质 |
| 交互控制 | `OrbitControls` 旋转缩放 |

核心原理：**UV 坐标做桥梁**——每个 3D 顶点带有 (u,v) 坐标指向 2D 纹理上的像素位置，GPU 在光栅化阶段自动完成插值采样，从而让平面设计"贴"在曲面上。
