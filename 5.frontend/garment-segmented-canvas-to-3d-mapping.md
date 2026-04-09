# 服装分片画布预览到 3D 模型各部位映射技术方案

## 一、问题定义

传统 POD 编辑器只有一个画布对应一个模型区域。**服装分片映射**需要解决的核心问题是：

> 一件衣服有多个可设计区域（前胸、后背、左袖、右袖、领口、下摆等），每个区域独立编辑，最终统一映射到同一个 3D 模型的对应部位上，实现实时预览。

**核心难点**：多画布 → 多纹理 → 多 Mesh 部位的绑定、同步与合成。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         UI Layer                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │
│  │ 前胸画布  │ │ 后背画布  │ │ 左袖画布  │ │ 右袖画布  │  ...         │
│  │ Fabric.js │ │ Fabric.js │ │ Fabric.js │ │ Fabric.js │              │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘               │
│       │             │             │             │                     │
├───────┼─────────────┼─────────────┼─────────────┼───────────────────┤
│       ▼             ▼             ▼             ▼                     │
│  ┌──────────────────────────────────────────────────────┐            │
│  │              Zone Registry (分片注册表)                │            │
│  │  zoneId → { canvas, meshName, uvConfig, mask }       │            │
│  └──────────────────────┬───────────────────────────────┘            │
│                         │                                            │
├─────────────────────────┼────────────────────────────────────────────┤
│                         ▼                                            │
│  ┌──────────────────────────────────────────────────────┐            │
│  │           Texture Compositor (纹理合成器)              │            │
│  │  方案 A：多材质独立贴图（每个 zone 独立材质）          │            │
│  │  方案 B：Atlas 合并到单张大纹理                        │            │
│  └──────────────────────┬───────────────────────────────┘            │
│                         │                                            │
├─────────────────────────┼────────────────────────────────────────────┤
│                         ▼                                            │
│  ┌──────────────────────────────────────────────────────┐            │
│  │              3D Renderer (Three.js)                    │            │
│  │  GLB 模型 → 按 mesh name 匹配 zone → 绑定材质         │            │
│  │  OrbitControls + HDR 环境光 + PBR 渲染                 │            │
│  └──────────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、核心流程

```
                    ┌─────────────┐
                    │  加载产品配置  │
                    │  (zones.json) │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │ 解析分片定义  │
                    │ front/back/  │
                    │ sleeve-L/R   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │ 创建画布1 │ │ 创建画布2 │ │ 创建画布N │   ← 每个zone一个Fabric.js实例
      └─────┬────┘ └─────┬────┘ └─────┬────┘
            │            │            │
      ┌─────▼────┐ ┌─────▼────┐ ┌─────▼────┐
      │ 用户编辑  │ │ 用户编辑  │ │ 用户编辑  │   ← 拖拽/文字/图片/滤镜
      └─────┬────┘ └─────┬────┘ └─────┬────┘
            │            │            │
            └────────────┼────────────┘
                         │
                  ┌──────▼──────┐
                  │  纹理导出     │
                  │  Canvas →    │
                  │  CanvasTexture│
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │  UV 贴图映射  │
                  │  zone → mesh │
                  │  纹理 → 材质  │
                  └──────┬──────┘
                         │
                  ┌──────▼──────┐
                  │ 3D 实时渲染   │
                  │ texture.     │
                  │ needsUpdate  │
                  └─────────────┘
```

---

## 四、产品配置数据结构

每个产品的分片信息由后端 / 配置文件下发：

```ts
// 产品分片配置
interface ProductConfig {
  productId: string;
  modelUrl: string;                   // GLB 模型地址
  zones: ZoneConfig[];                // 可设计分区列表
}

interface ZoneConfig {
  zoneId: string;                     // 唯一标识：'front' | 'back' | 'sleeve-left' | ...
  label: string;                      // 显示名称："前胸"
  meshName: string;                   // 对应 3D 模型中 Mesh 的 name
  canvasSize: { width: number; height: number };  // 画布像素尺寸
  printArea: { width: number; height: number };    // 物理印刷区域 (mm)
  maskUrl?: string;                   // 可选蒙版图（限制可印区域形状）
  uvTransform?: {                     // UV 偏移/缩放微调
    offsetX: number; offsetY: number;
    scaleX: number;  scaleY: number;
    rotation: number;
  };
}

// 示例：T恤配置
const tshirtConfig: ProductConfig = {
  productId: 'tshirt-v1',
  modelUrl: '/models/tshirt.glb',
  zones: [
    {
      zoneId: 'front',
      label: '前胸',
      meshName: 'Tshirt_Front',
      canvasSize: { width: 2000, height: 2400 },
      printArea: { width: 300, height: 360 },  // mm
      maskUrl: '/masks/tshirt-front.png',
    },
    {
      zoneId: 'back',
      label: '后背',
      meshName: 'Tshirt_Back',
      canvasSize: { width: 2000, height: 2400 },
      printArea: { width: 300, height: 360 },
    },
    {
      zoneId: 'sleeve-left',
      label: '左袖',
      meshName: 'Tshirt_Sleeve_L',
      canvasSize: { width: 800, height: 600 },
      printArea: { width: 120, height: 90 },
    },
    {
      zoneId: 'sleeve-right',
      label: '右袖',
      meshName: 'Tshirt_Sleeve_R',
      canvasSize: { width: 800, height: 600 },
      printArea: { width: 120, height: 90 },
    },
  ],
};
```

---

## 五、分片画布管理器（Zone Registry）

```ts
import { fabric } from 'fabric';

interface ZoneInstance {
  zoneId: string;
  config: ZoneConfig;
  canvas: fabric.Canvas;
  texture: THREE.CanvasTexture | null;
  dirty: boolean;                     // 标记是否需要重新导出
}

class ZoneCanvasManager {
  private zones = new Map<string, ZoneInstance>();
  private activeZoneId: string | null = null;

  // ── 初始化所有分区画布 ──
  initZones(configs: ZoneConfig[], containerMap: Map<string, HTMLCanvasElement>) {
    for (const config of configs) {
      const canvasEl = containerMap.get(config.zoneId)!;
      const fabricCanvas = new fabric.Canvas(canvasEl, {
        width: config.canvasSize.width,
        height: config.canvasSize.height,
        backgroundColor: '#ffffff',
        preserveObjectStacking: true,
      });

      // 加载蒙版作为 clipPath（限制设计区域形状）
      if (config.maskUrl) {
        fabric.Image.fromURL(config.maskUrl, (maskImg) => {
          fabricCanvas.clipPath = maskImg;
          fabricCanvas.renderAll();
        });
      }

      // 监听画布变更，标记脏位
      fabricCanvas.on('object:modified', () => this.markDirty(config.zoneId));
      fabricCanvas.on('object:added', () => this.markDirty(config.zoneId));
      fabricCanvas.on('object:removed', () => this.markDirty(config.zoneId));

      this.zones.set(config.zoneId, {
        zoneId: config.zoneId,
        config,
        canvas: fabricCanvas,
        texture: null,
        dirty: true,
      });
    }
  }

  // ── 切换当前激活的编辑区域 ──
  switchZone(zoneId: string) {
    // 上一个区域取消选中状态
    if (this.activeZoneId) {
      this.zones.get(this.activeZoneId)?.canvas.discardActiveObject();
    }
    this.activeZoneId = zoneId;
    // 可触发 UI 切换 tab / 高亮对应的 3D mesh
  }

  // ── 导出某个分区的画布为 HTMLCanvasElement ──
  exportZoneTexture(zoneId: string, multiplier = 2): HTMLCanvasElement {
    const zone = this.zones.get(zoneId)!;
    const fc = zone.canvas;

    // 隐藏辅助元素
    const helpers = fc.getObjects().filter(o => o.data?.type === 'helper');
    helpers.forEach(o => (o.visible = false));

    const exported = fc.toCanvasElement(multiplier);

    helpers.forEach(o => (o.visible = true));
    fc.renderAll();

    zone.dirty = false;
    return exported;
  }

  // ── 批量导出所有脏分区 ──
  exportDirtyZones(multiplier = 2): Map<string, HTMLCanvasElement> {
    const result = new Map<string, HTMLCanvasElement>();
    for (const [zoneId, zone] of this.zones) {
      if (zone.dirty) {
        result.set(zoneId, this.exportZoneTexture(zoneId, multiplier));
      }
    }
    return result;
  }

  private markDirty(zoneId: string) {
    const zone = this.zones.get(zoneId);
    if (zone) zone.dirty = true;
  }

  getZone(zoneId: string) { return this.zones.get(zoneId); }
  getAllZones() { return Array.from(this.zones.values()); }
}
```

---

## 六、3D 模型加载与多 Mesh 绑定

### 6.1 模型规范（Blender 建模侧）

```
3D 模型 (tshirt.glb) 的 Mesh 命名约定：

Scene
├── Tshirt_Front       ← meshName 与 zoneId 'front' 对应
├── Tshirt_Back        ← meshName 与 zoneId 'back' 对应
├── Tshirt_Sleeve_L    ← meshName 与 zoneId 'sleeve-left' 对应
├── Tshirt_Sleeve_R    ← meshName 与 zoneId 'sleeve-right' 对应
├── Tshirt_Collar      ← 不可编辑部位（固定材质）
└── Tshirt_Body        ← 基础布料（固定底色）

每个 Mesh 独立 UV 展开，UV 空间 (0,0)~(1,1) 完整对应该区域的设计画布。
```

### 6.2 模型加载与 Mesh 索引

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

class GarmentViewer3D {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;

  // 核心：meshName → Mesh 的索引表
  private meshMap = new Map<string, THREE.Mesh>();
  // zoneId → CanvasTexture 的纹理缓存
  private textureMap = new Map<string, THREE.CanvasTexture>();

  constructor(container: HTMLElement) {
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      45, container.clientWidth / container.clientHeight, 0.1, 100
    );
    this.camera.position.set(0, 1.0, 3.0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.6, 0);

    // HDR 环境光
    new RGBELoader().load('/envmaps/studio_small.hdr', (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = hdr;
    });

    this.animate();
  }

  // ── 加载模型并建立 mesh 索引 ──
  async loadModel(modelUrl: string, zones: ZoneConfig[]): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(modelUrl);
    const meshNames = new Set(zones.map(z => z.meshName));

    gltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;

        // 按名称索引可设计区域的 mesh
        if (meshNames.has(child.name)) {
          this.meshMap.set(child.name, child);
        }
      }
    });

    this.scene.add(gltf.scene);
  }

  // ── 将某个分区的纹理绑定到对应 Mesh ──
  applyZoneTexture(zone: ZoneConfig, designCanvas: HTMLCanvasElement) {
    const mesh = this.meshMap.get(zone.meshName);
    if (!mesh) return;

    let texture = this.textureMap.get(zone.zoneId);

    if (!texture) {
      // 首次创建纹理
      texture = new THREE.CanvasTexture(designCanvas);
      texture.flipY = true;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;

      // 应用 UV 微调
      if (zone.uvTransform) {
        const t = zone.uvTransform;
        texture.offset.set(t.offsetX, t.offsetY);
        texture.repeat.set(t.scaleX, t.scaleY);
        texture.rotation = t.rotation;
        texture.center.set(0.5, 0.5);
      }

      this.textureMap.set(zone.zoneId, texture);

      // PBR 材质
      mesh.material = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.85,
        metalness: 0.0,
        side: THREE.DoubleSide,
      });
    } else {
      // 后续更新：只替换 image source
      texture.image = designCanvas;
      texture.needsUpdate = true;
    }
  }

  // ── 批量更新多个分区 ──
  applyAllZoneTextures(
    zones: ZoneConfig[],
    canvasMap: Map<string, HTMLCanvasElement>
  ) {
    for (const zone of zones) {
      const canvas = canvasMap.get(zone.zoneId);
      if (canvas) this.applyZoneTexture(zone, canvas);
    }
  }

  // ── 高亮某个区域的 Mesh（鼠标 hover / 点击选区切换） ──
  highlightZone(meshName: string, highlight: boolean) {
    const mesh = this.meshMap.get(meshName);
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.emissive = highlight
      ? new THREE.Color(0x3388ff).multiplyScalar(0.15)
      : new THREE.Color(0x000000);
  }

  // ── 旋转到指定视角（如点击"后背"自动转到背面） ──
  rotateTo(target: 'front' | 'back' | 'left' | 'right', duration = 600) {
    const angles: Record<string, { x: number; z: number }> = {
      front: { x: 0, z: 3 },
      back:  { x: 0, z: -3 },
      left:  { x: -3, z: 0 },
      right: { x: 3, z: 0 },
    };
    const { x, z } = angles[target];
    // 使用 tween 平滑过渡（此处简化为直接设置）
    this.camera.position.set(x, 1.0, z);
    this.camera.lookAt(0, 0.6, 0);
  }

  getMesh(meshName: string) { return this.meshMap.get(meshName); }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
```

---

## 七、纹理合成器（两种方案对比）

### 方案 A：多材质独立贴图（推荐）

```
每个 zone 的 Mesh 使用独立的 MeshStandardMaterial + CanvasTexture

优点：实现简单、独立更新互不干扰、Blender 建模直观
缺点：drawcall 数量 = zone 数量（通常 4-6 个，可接受）

Mesh: Tshirt_Front   → Material_Front   → CanvasTexture_Front
Mesh: Tshirt_Back    → Material_Back    → CanvasTexture_Back
Mesh: Tshirt_Sleeve_L → Material_SleeveL → CanvasTexture_SleeveL
Mesh: Tshirt_Sleeve_R → Material_SleeveR → CanvasTexture_SleeveR
```

### 方案 B：Atlas 纹理合并（大规模场景）

```
所有 zone 合并到一张大纹理（Texture Atlas），模型使用单一材质

优点：1 drawcall，GPU 友好
缺点：UV 重新映射复杂、更新需要重绘整张 Atlas

┌──────────────────────────────┐
│  Atlas Texture (4096×4096)   │
│ ┌──────────┬──────────┐      │
│ │  Front   │  Back    │      │
│ │ (0,0.5)  │ (0.5,0.5)│      │
│ ├──────────┼──────────┤      │
│ │ Sleeve-L │ Sleeve-R │      │
│ │ (0,0)    │ (0.5,0)  │      │
│ └──────────┴──────────┘      │
└──────────────────────────────┘
```

Atlas 合成器实现：

```ts
class TextureAtlasCompositor {
  private atlasCanvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private atlasSize = 4096;

  // 每个 zone 在 atlas 中的位置
  private layout: Map<string, { x: number; y: number; w: number; h: number }>;

  constructor(zones: ZoneConfig[]) {
    this.atlasCanvas = document.createElement('canvas');
    this.atlasCanvas.width = this.atlasSize;
    this.atlasCanvas.height = this.atlasSize;
    this.ctx = this.atlasCanvas.getContext('2d')!;

    // 简单的 2×N 网格布局
    this.layout = this.computeLayout(zones);
  }

  // ── 将某个 zone 的画布绘制到 Atlas 对应位置 ──
  updateZone(zoneId: string, zoneCanvas: HTMLCanvasElement) {
    const rect = this.layout.get(zoneId);
    if (!rect) return;

    // 清除旧内容
    this.ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    // 绘制新内容（缩放适配）
    this.ctx.drawImage(zoneCanvas, rect.x, rect.y, rect.w, rect.h);
  }

  // ── 批量更新后返回整个 atlas ──
  getAtlasCanvas(): HTMLCanvasElement {
    return this.atlasCanvas;
  }

  // ── 获取某个 zone 的 UV 偏移和缩放 ──
  getUVTransform(zoneId: string): { offset: [number, number]; scale: [number, number] } {
    const rect = this.layout.get(zoneId)!;
    return {
      offset: [rect.x / this.atlasSize, rect.y / this.atlasSize],
      scale: [rect.w / this.atlasSize, rect.h / this.atlasSize],
    };
  }

  private computeLayout(zones: ZoneConfig[]) {
    const map = new Map<string, { x: number; y: number; w: number; h: number }>();
    const cols = 2;
    const cellW = this.atlasSize / cols;
    const rows = Math.ceil(zones.length / cols);
    const cellH = this.atlasSize / rows;

    zones.forEach((z, i) => {
      map.set(z.zoneId, {
        x: (i % cols) * cellW,
        y: Math.floor(i / cols) * cellH,
        w: cellW,
        h: cellH,
      });
    });
    return map;
  }
}
```

---

## 八、实时同步管线

```
用户拖动前胸画布上的图片
       │
       ▼
 Fabric.js 触发 object:modified
       │
       ▼
 ZoneCanvasManager.markDirty('front')
       │
       ▼
 SyncScheduler 检测到 dirty zones（requestAnimationFrame 节流）
       │
       ▼
 exportDirtyZones() → 导出 front 的 HTMLCanvasElement
       │
       ▼
 GarmentViewer3D.applyZoneTexture(frontZone, canvas)
       │
       ▼
 texture.image = canvas; texture.needsUpdate = true;
       │
       ▼
 下一帧 Three.js 渲染 → GPU 重新上传纹理 → 3D 预览更新
```

```ts
class SyncScheduler {
  private zoneManager: ZoneCanvasManager;
  private viewer: GarmentViewer3D;
  private zones: ZoneConfig[];
  private rafId: number | null = null;
  private syncing = false;

  constructor(
    zoneManager: ZoneCanvasManager,
    viewer: GarmentViewer3D,
    zones: ZoneConfig[]
  ) {
    this.zoneManager = zoneManager;
    this.viewer = viewer;
    this.zones = zones;
  }

  start() {
    this.tick();
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  private tick = () => {
    this.rafId = requestAnimationFrame(this.tick);

    if (this.syncing) return;
    this.syncing = true;

    // 只导出发生变更的分区
    const dirtyCanvases = this.zoneManager.exportDirtyZones();

    if (dirtyCanvases.size > 0) {
      // 批量更新 3D 纹理
      for (const [zoneId, canvas] of dirtyCanvases) {
        const zone = this.zones.find(z => z.zoneId === zoneId)!;
        this.viewer.applyZoneTexture(zone, canvas);
      }
    }

    this.syncing = false;
  };
}
```

---

## 九、蒙版材质 Shader（局部印花限制）

当分区形状不规则（如袖口弧线、领口曲线）时，用蒙版 shader 控制设计图只出现在可印区域：

```ts
class ZoneMaskedMaterial {
  static create(
    designCanvas: HTMLCanvasElement,
    maskUrl: string,
    baseColor: string,
    fabricNormalUrl?: string
  ): THREE.ShaderMaterial {
    const designTex = new THREE.CanvasTexture(designCanvas);
    designTex.colorSpace = THREE.SRGBColorSpace;
    designTex.anisotropy = 16;

    const maskTex = new THREE.TextureLoader().load(maskUrl);
    const normalTex = fabricNormalUrl
      ? new THREE.TextureLoader().load(fabricNormalUrl)
      : null;

    return new THREE.ShaderMaterial({
      uniforms: {
        uDesign:    { value: designTex },
        uMask:      { value: maskTex },
        uBaseColor: { value: new THREE.Color(baseColor) },
        uNormalMap:  { value: normalTex },
        uRoughness: { value: 0.85 },
        // 环境光贴图由 scene.environment 提供，此处通过 envMap 注入
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vWorldPos;

        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uDesign;
        uniform sampler2D uMask;
        uniform vec3 uBaseColor;
        uniform float uRoughness;
        varying vec2 vUv;
        varying vec3 vNormal;

        void main() {
          vec4 design = texture2D(uDesign, vUv);
          float mask  = texture2D(uMask, vUv).r;     // 白色=可印  黑色=不可印

          // 设计图与底色混合（蒙版控制）
          vec3 color = mix(uBaseColor, design.rgb, design.a * mask);

          // 简化的漫反射光照
          vec3 lightDir = normalize(vec3(1.0, 1.0, 1.0));
          float diff = max(dot(vNormal, lightDir), 0.0) * 0.6 + 0.4;

          gl_FragColor = vec4(color * diff, 1.0);
        }
      `,
    });
  }

  // 更新设计纹理（无需重建材质）
  static updateDesign(material: THREE.ShaderMaterial, newCanvas: HTMLCanvasElement) {
    const tex = material.uniforms.uDesign.value as THREE.CanvasTexture;
    tex.image = newCanvas;
    tex.needsUpdate = true;
  }
}
```

---

## 十、3D 模型点击选区交互

点击 3D 模型某个部位 → 自动切换到对应的 2D 画布编辑：

```ts
class ZonePicker {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private viewer: GarmentViewer3D;
  private zones: ZoneConfig[];
  private onZoneSelected: (zoneId: string) => void;

  constructor(
    viewer: GarmentViewer3D,
    zones: ZoneConfig[],
    onZoneSelected: (zoneId: string) => void
  ) {
    this.viewer = viewer;
    this.zones = zones;
    this.onZoneSelected = onZoneSelected;

    viewer.renderer.domElement.addEventListener('click', this.onClick);
    viewer.renderer.domElement.addEventListener('pointermove', this.onHover);
  }

  private onClick = (e: MouseEvent) => {
    const zoneId = this.pickZone(e);
    if (zoneId) this.onZoneSelected(zoneId);
  };

  private onHover = (e: MouseEvent) => {
    // 高亮悬停区域
    const zoneId = this.pickZone(e);
    for (const zone of this.zones) {
      this.viewer.highlightZone(zone.meshName, zone.zoneId === zoneId);
    }
    viewer.renderer.domElement.style.cursor = zoneId ? 'pointer' : 'default';
  };

  private pickZone(e: MouseEvent): string | null {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.viewer.camera);

    // 只检测可设计区域的 mesh
    const meshes = this.zones
      .map(z => this.viewer.getMesh(z.meshName))
      .filter(Boolean) as THREE.Mesh[];

    const intersects = this.raycaster.intersectObjects(meshes);

    if (intersects.length > 0) {
      const hitMesh = intersects[0].object as THREE.Mesh;
      const zone = this.zones.find(z => z.meshName === hitMesh.name);
      return zone?.zoneId ?? null;
    }
    return null;
  }
}
```

---

## 十一、Blender 建模规范

分片映射对 3D 模型有严格要求：

```python
# Blender Python 脚本：T恤分片 UV 展开自动化

import bpy, bmesh, math

garment = bpy.context.active_object

# 定义各部位面片的筛选规则（法线方向 + 顶点范围）
zone_rules = {
    'Tshirt_Front': {
        'normal_test': lambda n: n.y < -0.5,          # 法线朝前（-Y）
        'bounds_test': lambda co: co.z > 0.3,          # 腰线以上
    },
    'Tshirt_Back': {
        'normal_test': lambda n: n.y > 0.5,            # 法线朝后（+Y）
        'bounds_test': lambda co: co.z > 0.3,
    },
    'Tshirt_Sleeve_L': {
        'normal_test': lambda n: n.x < -0.5,           # 法线朝左
        'bounds_test': lambda co: co.z > 0.8,
    },
    'Tshirt_Sleeve_R': {
        'normal_test': lambda n: n.x > 0.5,            # 法线朝右
        'bounds_test': lambda co: co.z > 0.8,
    },
}

bpy.ops.object.mode_set(mode='EDIT')
bm = bmesh.from_edit_mesh(garment.data)

for zone_name, rules in zone_rules.items():
    # 清除选择
    for f in bm.faces:
        f.select = False

    # 按规则选择面
    for face in bm.faces:
        center = face.calc_center_median()
        if rules['normal_test'](face.normal) and rules['bounds_test'](center):
            face.select = True

    bmesh.update_edit_mesh(garment.data)

    # 分离选中面为独立 Mesh
    bpy.ops.mesh.separate(type='SELECTED')

    # 重命名
    new_obj = bpy.context.selected_objects[-1]
    new_obj.name = zone_name

    # 对独立 Mesh 做 UV 展开
    bpy.context.view_layer.objects.active = new_obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=66, island_margin=0.02)
    bpy.ops.object.mode_set(mode='OBJECT')

# 导出包含所有分片 Mesh 的 GLB
bpy.ops.export_scene.gltf(
    filepath='/output/tshirt_segmented.glb',
    export_format='GLB',
    export_texcoords=True,
    export_normals=True,
    export_materials='NONE',  # 材质由前端代码动态创建
)
```

---

## 十二、完整集成入口

```ts
class SegmentedGarmentEditor {
  private zoneManager: ZoneCanvasManager;
  private viewer: GarmentViewer3D;
  private scheduler: SyncScheduler;
  private picker: ZonePicker;

  async init(config: ProductConfig, container3D: HTMLElement) {
    // 1. 初始化所有分区画布
    this.zoneManager = new ZoneCanvasManager();
    const canvasMap = this.createCanvasElements(config.zones);  // 动态创建 DOM
    this.zoneManager.initZones(config.zones, canvasMap);

    // 2. 初始化 3D 查看器
    this.viewer = new GarmentViewer3D(container3D);
    await this.viewer.loadModel(config.modelUrl, config.zones);

    // 3. 初次全量贴图
    for (const zone of config.zones) {
      const canvas = this.zoneManager.exportZoneTexture(zone.zoneId);
      this.viewer.applyZoneTexture(zone, canvas);
    }

    // 4. 启动实时同步
    this.scheduler = new SyncScheduler(this.zoneManager, this.viewer, config.zones);
    this.scheduler.start();

    // 5. 3D 点击选区交互
    this.picker = new ZonePicker(this.viewer, config.zones, (zoneId) => {
      this.zoneManager.switchZone(zoneId);
      this.onZoneSwitch(zoneId);  // UI 联动
    });

    // 6. 默认选中前胸
    this.zoneManager.switchZone('front');
  }

  // ── 切换产品颜色 ──
  changeBaseColor(color: string) {
    for (const zone of this.config.zones) {
      const mesh = this.viewer.getMesh(zone.meshName);
      if (mesh) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.set(color);
      }
    }
  }

  // ── 导出所有分区的高清设计图（供印刷） ──
  exportForPrint(): Map<string, Blob> {
    const result = new Map<string, Blob>();
    for (const zone of this.config.zones) {
      const canvas = this.zoneManager.exportZoneTexture(zone.zoneId, 4); // 4x for 300dpi
      canvas.toBlob((blob) => {
        if (blob) result.set(zone.zoneId, blob);
      }, 'image/png');
    }
    return result;
  }

  private createCanvasElements(zones: ZoneConfig[]): Map<string, HTMLCanvasElement> {
    // 根据 zone 配置动态创建 <canvas> 元素并挂载到 DOM
    const map = new Map<string, HTMLCanvasElement>();
    for (const zone of zones) {
      const el = document.createElement('canvas');
      el.width = zone.canvasSize.width;
      el.height = zone.canvasSize.height;
      el.id = `canvas-${zone.zoneId}`;
      document.getElementById('canvas-container')!.appendChild(el);
      map.set(zone.zoneId, el);
    }
    return map;
  }

  private onZoneSwitch(zoneId: string) {
    // UI 联动：tab 切换、属性面板切换、3D 视角旋转
    const zone = this.config.zones.find(z => z.zoneId === zoneId)!;
    const viewMap: Record<string, 'front' | 'back' | 'left' | 'right'> = {
      front: 'front', back: 'back',
      'sleeve-left': 'left', 'sleeve-right': 'right',
    };
    this.viewer.rotateTo(viewMap[zoneId] || 'front');
    this.viewer.highlightZone(zone.meshName, true);
  }
}
```

---

## 十三、性能优化策略

| 优化方向 | 策略 | 效果 |
|---------|------|------|
| **脏检测** | 只导出修改过的 zone，未修改的跳过 | 减少 60-80% 纹理导出 |
| **节流同步** | requestAnimationFrame 节流，不使用 setInterval | 稳定 60fps |
| **纹理复用** | 不重建 CanvasTexture，只替换 `.image` | 避免 GPU 内存抖动 |
| **降采样预览** | 编辑中使用 multiplier=1，空闲时切换到 2x | 编辑时 4 倍性能提升 |
| **离屏渲染** | OffscreenCanvas + Worker 导出纹理 | 不阻塞主线程 |
| **LOD 模型** | 远处用低面数模型，近处切换高面数 | 移动端性能 |
| **纹理尺寸** | 预览用 1024px，导出用 4096px | 显存减少 75% |

```ts
// 自适应质量：编辑中降低纹理精度，停止操作后提高
class AdaptiveQuality {
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  onUserActive(zoneManager: ZoneCanvasManager, viewer: GarmentViewer3D, zones: ZoneConfig[]) {
    if (this.idleTimer) clearTimeout(this.idleTimer);

    // 用户操作中：低精度快速预览
    this.syncWithQuality(zoneManager, viewer, zones, 1);

    // 停止操作 500ms 后：高精度渲染
    this.idleTimer = setTimeout(() => {
      this.syncWithQuality(zoneManager, viewer, zones, 2);
    }, 500);
  }

  private syncWithQuality(
    zm: ZoneCanvasManager, v: GarmentViewer3D,
    zones: ZoneConfig[], multiplier: number
  ) {
    for (const zone of zones) {
      const canvas = zm.exportZoneTexture(zone.zoneId, multiplier);
      v.applyZoneTexture(zone, canvas);
    }
  }
}
```

---

## 十四、关键难点与方案总结

| 难点 | 解决方案 |
|------|---------|
| 多画布 ↔ 多 Mesh 绑定 | Zone Registry 统一管理，meshName 作为绑定键 |
| UV 展开精度 | Blender 分片自动展开，每个部位独占 UV 空间 (0,0)~(1,1) |
| 实时同步性能 | 脏检测 + RAF 节流 + 自适应质量 |
| 不规则印花区域 | ShaderMaterial + 灰度蒙版 |
| 3D 点击选区 | Raycaster 射线检测 + Mesh 索引 |
| 视角联动 | 切换 zone 时自动旋转相机到对应视角 |
| 曲面贴合 | 各部位独立 UV 投影（平面/圆柱/球面） |
| 印刷级导出 | multiplier=4 高倍导出 + DPI 换算 |

---

## 技术关键点一句话总结

> **核心原理**：3D 模型在 Blender 中按服装部位拆分为独立 Mesh，每个 Mesh 独立 UV 展开；前端为每个部位创建独立 Fabric.js 画布，用户编辑后通过 `CanvasTexture` 映射到对应 Mesh 的材质上；脏检测 + requestAnimationFrame 节流保证实时同步性能；Raycaster 射线检测实现 3D 点击切换编辑区域的交互闭环。
