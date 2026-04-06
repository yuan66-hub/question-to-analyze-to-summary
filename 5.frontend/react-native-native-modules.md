# React Native 原生模块开发：iOS/Android 基础概念与桥接实战

## 一、iOS 基本开发概念

### 1.1 语言：Objective-C vs Swift

| 维度 | Objective-C | Swift |
|------|------------|-------|
| 历史 | 1984 年，Apple 生态主力 30+ 年 | 2014 年发布，Apple 主推 |
| 语法风格 | C 超集，消息发送机制 `[obj method]` | 现代语法，类型推断，类似 TypeScript |
| RN 兼容性 | 原生支持，文档最全 | 需要桥接头文件，社区支持完善 |
| 建议 | 看懂即可，维护老项目用 | 新模块优先用 Swift |

```objc
// Objective-C 基本语法
@interface MyClass : NSObject
@property (nonatomic, strong) NSString *name;
- (void)sayHello;
@end

@implementation MyClass
- (void)sayHello {
    NSLog(@"Hello, %@", self.name);
}
@end
```

```swift
// Swift 等价写法
class MyClass {
    var name: String
    init(name: String) { self.name = name }
    func sayHello() { print("Hello, \(name)") }
}
```

### 1.2 iOS 核心概念

**UIKit 框架（传统 UI 层）：**

```
UIApplication          → 应用入口，管理生命周期
├── UIWindow           → 窗口容器（通常只有一个）
│   └── UIViewController → 页面控制器（核心单元）
│       └── UIView     → 视图树（类似 DOM 树）
│           ├── UILabel
│           ├── UIButton
│           └── UIImageView
```

**生命周期（类比 React）：**

| iOS (UIViewController) | React 组件 | 时机 |
|------------------------|------------|------|
| `viewDidLoad` | `componentDidMount` / `useEffect(,[])` | 视图加载完成 |
| `viewWillAppear` | — | 即将显示 |
| `viewDidAppear` | — | 已经显示 |
| `viewWillDisappear` | `componentWillUnmount` / cleanup | 即将消失 |
| `dealloc` | GC 回收 | 内存释放 |

**核心机制：**

- **Delegate 模式**：类似事件回调，一个对象把行为委托给另一个对象处理（如 `UITableViewDelegate`）
- **Target-Action**：按钮点击等事件绑定，类似 `onClick`
- **KVO (Key-Value Observing)**：属性监听，类似 Vue 的 `watch`
- **NSNotificationCenter**：全局事件总线，类似 `EventEmitter`
- **GCD (Grand Central Dispatch)**：多线程调度，原生模块里高频使用

```swift
// GCD 示例：在后台线程做耗时操作，回到主线程更新 UI
DispatchQueue.global(qos: .background).async {
    let result = heavyComputation()
    DispatchQueue.main.async {
        // 更新 UI 必须在主线程
        self.label.text = result
    }
}
```

### 1.3 iOS 项目结构（RN 项目中的 ios/ 目录）

```
ios/
├── MyApp/
│   ├── AppDelegate.m(.swift)   → 应用入口，初始化 RN Bridge
│   ├── Info.plist               → 配置文件（权限声明、URL Scheme 等）
│   └── LaunchScreen.storyboard  → 启动屏
├── Podfile                      → 依赖管理（类似 package.json）
└── MyApp.xcworkspace            → Xcode 工程入口
```

---

## 二、Android 基本开发概念

### 2.1 语言：Java vs Kotlin

| 维度 | Java | Kotlin |
|------|------|--------|
| 历史 | Android 原生语言 | 2017 年 Google 官方推荐 |
| 语法 | 冗长但直观 | 简洁，空安全，协程 |
| RN 兼容性 | 原生支持 | 完全兼容，可混用 |
| 建议 | 看懂即可 | 新模块优先用 Kotlin |

```java
// Java 基本语法
public class MyClass {
    private String name;
    public MyClass(String name) { this.name = name; }
    public void sayHello() {
        Log.d("MyClass", "Hello, " + name);
    }
}
```

```kotlin
// Kotlin 等价写法
class MyClass(private val name: String) {
    fun sayHello() {
        Log.d("MyClass", "Hello, $name")
    }
}
```

### 2.2 Android 核心概念

**四大组件：**

| 组件 | 作用 | 前端类比 |
|------|------|----------|
| **Activity** | 一个页面/屏幕 | 一个路由页面 |
| **Service** | 后台任务（音乐播放、下载） | Web Worker |
| **BroadcastReceiver** | 系统/应用事件监听 | EventListener |
| **ContentProvider** | 跨应用数据共享 | 公共 API |

**Activity 生命周期（类比 React）：**

```
onCreate()    → componentDidMount    → 创建（初始化 UI）
onStart()     → —                    → 可见
onResume()    → —                    → 前台可交互
onPause()     → —                    → 部分遮挡
onStop()      → —                    → 完全不可见
onDestroy()   → componentWillUnmount → 销毁
```

**核心机制：**

- **Intent**：组件间通信的信使（类似路由跳转 + 传参）
- **Context**：应用环境上下文（获取资源、启动组件、访问系统服务的入口）
- **Handler/Looper**：消息循环机制，UI 线程调度（类似事件循环）
- **SharedPreferences**：轻量 KV 存储（类似 localStorage）
- **Coroutines (Kotlin)**：协程，异步编程方案（类似 async/await）

```kotlin
// Kotlin 协程：类似 JS 的 async/await
lifecycleScope.launch {
    val result = withContext(Dispatchers.IO) {
        heavyComputation() // 在 IO 线程执行
    }
    textView.text = result // 自动回到主线程
}
```

### 2.3 Android 项目结构（RN 项目中的 android/ 目录）

```
android/
├── app/
│   ├── src/main/
│   │   ├── java/com/myapp/       → 源码目录
│   │   │   ├── MainActivity.kt   → 主 Activity，承载 RN
│   │   │   └── MainApplication.kt → 应用入口，注册原生模块
│   │   ├── AndroidManifest.xml   → 清单文件（权限、组件声明）
│   │   └── res/                  → 资源文件（图片、布局、字符串）
│   └── build.gradle              → 模块级构建配置
├── build.gradle                  → 项目级构建配置
└── settings.gradle               → 模块声明
```

---

## 三、React Native 桥接架构

### 3.1 旧架构（Bridge）

```
┌─────────────┐    JSON 序列化    ┌──────────────┐
│   JS 线程    │ ◄──────────────► │  Bridge 队列  │
│  (Hermes)   │    异步、批量      │   (C++ 层)   │
└─────────────┘                   └──────┬───────┘
                                         │
                               ┌─────────┴─────────┐
                               │                    │
                        ┌──────┴──────┐    ┌───────┴───────┐
                        │  UI 线程     │    │  Native 线程   │
                        │ (主线程渲染) │    │ (原生模块执行)  │
                        └─────────────┘    └───────────────┘
```

**瓶颈**：所有通信必须经过 Bridge 序列化/反序列化 JSON，异步且有延迟。

### 3.2 新架构（Fabric + TurboModules + JSI）

```
┌─────────────┐     JSI (C++ 直调)     ┌──────────────┐
│   JS 线程    │ ◄────────────────────► │  C++ Host     │
│  (Hermes)   │    同步/异步，零拷贝     │  Objects      │
└─────────────┘                        └──────┬───────┘
                                              │
                                    ┌─────────┴─────────┐
                                    │                    │
                             ┌──────┴──────┐    ┌───────┴───────┐
                             │  Fabric      │    │ TurboModules  │
                             │ (新渲染器)    │    │ (懒加载原生模块)│
                             └─────────────┘    └───────────────┘
```

**关键改进：**

| 维度 | 旧架构 | 新架构 |
|------|--------|--------|
| 通信方式 | JSON Bridge（异步批量） | JSI 直接调用（同步可选） |
| 模块加载 | 启动时全量注册 | TurboModules 懒加载 |
| 渲染器 | Paper（JS 驱动） | Fabric（C++ 共享） |
| 类型安全 | 无 | Codegen 生成类型 |
| 性能 | 跨桥序列化开销大 | 接近原生调用 |

---

## 四、实战：编写 React Native 原生模块

### 4.1 场景：设备信息模块

目标：暴露一个 `DeviceInfo` 模块给 JS 层，提供：
- `getDeviceName(): Promise<string>` — 获取设备名称
- `getBatteryLevel(): Promise<number>` — 获取电池电量
- `onBatteryChange(callback)` — 监听电量变化事件

### 4.2 Android 端实现 (Kotlin)

**Step 1：创建 Module 类**

```kotlin
// android/app/src/main/java/com/myapp/DeviceInfoModule.kt
package com.myapp

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule

class DeviceInfoModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    // 模块名：JS 端通过 NativeModules.DeviceInfo 访问
    override fun getName(): String = "DeviceInfo"

    // 同步导出常量（启动时传递给 JS）
    override fun getConstants(): Map<String, Any> = mapOf(
        "osName" to "Android",
        "sdkVersion" to Build.VERSION.SDK_INT
    )

    // 异步方法：通过 @ReactMethod 注解暴露给 JS
    // Promise 参数自动映射为 JS 的 Promise
    @ReactMethod
    fun getDeviceName(promise: Promise) {
        try {
            promise.resolve(Build.MODEL)
        } catch (e: Exception) {
            promise.reject("ERR_DEVICE_NAME", e.message)
        }
    }

    @ReactMethod
    fun getBatteryLevel(promise: Promise) {
        val batteryManager = reactApplicationContext
            .getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val level = batteryManager.getIntProperty(
            BatteryManager.BATTERY_PROPERTY_CAPACITY
        )
        promise.resolve(level / 100.0)
    }

    // 事件发射：向 JS 发送事件
    private fun sendEvent(eventName: String, params: WritableMap?) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, params)
    }

    // 监听电池变化，广播给 JS
    private var batteryReceiver: BroadcastReceiver? = null

    @ReactMethod
    fun startBatteryMonitor() {
        batteryReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                val params = Arguments.createMap().apply {
                    putDouble("level", level.toDouble() / scale)
                }
                sendEvent("onBatteryChange", params)
            }
        }
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        reactApplicationContext.registerReceiver(batteryReceiver, filter)
    }

    @ReactMethod
    fun stopBatteryMonitor() {
        batteryReceiver?.let {
            reactApplicationContext.unregisterReceiver(it)
            batteryReceiver = null
        }
    }

    // 告诉 RN 这个模块会发射哪些事件（新架构需要）
    @ReactMethod
    fun addListener(eventName: String) { /* Required for RN event emitter */ }
    @ReactMethod
    fun removeListeners(count: Int) { /* Required for RN event emitter */ }
}
```

**Step 2：创建 Package 注册类**

```kotlin
// android/app/src/main/java/com/myapp/DeviceInfoPackage.kt
package com.myapp

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class DeviceInfoPackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext
    ): List<NativeModule> = listOf(DeviceInfoModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext
    ): List<ViewManager<*, *>> = emptyList()
}
```

**Step 3：在 Application 中注册**

```kotlin
// android/app/src/main/java/com/myapp/MainApplication.kt
override fun getPackages(): List<ReactPackage> = listOf(
    MainReactPackage(),
    DeviceInfoPackage()  // ← 加这一行
)
```

### 4.3 iOS 端实现 (Swift)

**Step 1：创建 Module 类**

```swift
// ios/MyApp/DeviceInfoModule.swift
import Foundation
import UIKit

@objc(DeviceInfo)
class DeviceInfoModule: RCTEventEmitter {

    // 声明支持的事件
    override func supportedEvents() -> [String] {
        return ["onBatteryChange"]
    }

    // 导出常量
    override func constantsToExport() -> [AnyHashable: Any] {
        return [
            "osName": "iOS",
            "systemVersion": UIDevice.current.systemVersion
        ]
    }

    // 必须重写：允许在非主线程初始化
    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    // 获取设备名
    @objc func getDeviceName(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        resolve(UIDevice.current.name)
    }

    // 获取电池电量
    @objc func getBatteryLevel(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        DispatchQueue.main.async {
            UIDevice.current.isBatteryMonitoringEnabled = true
            let level = UIDevice.current.batteryLevel
            resolve(level) // 0.0 ~ 1.0
        }
    }

    // 监听电池变化
    @objc func startBatteryMonitor() {
        DispatchQueue.main.async {
            UIDevice.current.isBatteryMonitoringEnabled = true
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(self.batteryLevelDidChange),
                name: UIDevice.batteryLevelDidChangeNotification,
                object: nil
            )
        }
    }

    @objc func batteryLevelDidChange(_ notification: Notification) {
        sendEvent(withName: "onBatteryChange", body: [
            "level": UIDevice.current.batteryLevel
        ])
    }

    @objc func stopBatteryMonitor() {
        NotificationCenter.default.removeObserver(
            self,
            name: UIDevice.batteryLevelDidChangeNotification,
            object: nil
        )
    }
}
```

**Step 2：Objective-C 桥接文件（Swift 必需）**

```objc
// ios/MyApp/DeviceInfoModule.m
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(DeviceInfo, RCTEventEmitter)

RCT_EXTERN_METHOD(getDeviceName:
    (RCTPromiseResolveBlock)resolve
    rejecter:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(getBatteryLevel:
    (RCTPromiseResolveBlock)resolve
    rejecter:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(startBatteryMonitor)
RCT_EXTERN_METHOD(stopBatteryMonitor)

@end
```

> 为什么需要 `.m` 文件？RN 的模块注册宏 `RCT_EXTERN_MODULE` 是 Objective-C 宏，Swift 无法直接使用，必须通过 `.m` 桥接。

### 4.4 JS 端调用

**封装 TypeScript 接口：**

```typescript
// src/modules/DeviceInfo.ts
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';

const { DeviceInfo } = NativeModules;
const eventEmitter = new NativeEventEmitter(DeviceInfo);

// 类型定义
interface DeviceInfoModule {
  osName: string;
  sdkVersion?: number;       // Android only
  systemVersion?: string;    // iOS only
  getDeviceName(): Promise<string>;
  getBatteryLevel(): Promise<number>;
  startBatteryMonitor(): void;
  stopBatteryMonitor(): void;
}

// 导出常量
export const OS_NAME: string = DeviceInfo.osName;

// 导出方法
export async function getDeviceName(): Promise<string> {
  return DeviceInfo.getDeviceName();
}

export async function getBatteryLevel(): Promise<number> {
  return DeviceInfo.getBatteryLevel();
}

// 导出事件订阅
export function onBatteryChange(
  callback: (data: { level: number }) => void
) {
  DeviceInfo.startBatteryMonitor();
  const subscription = eventEmitter.addListener('onBatteryChange', callback);

  // 返回取消订阅函数
  return () => {
    subscription.remove();
    DeviceInfo.stopBatteryMonitor();
  };
}
```

**在 React 组件中使用：**

```tsx
// src/screens/DeviceScreen.tsx
import { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { getDeviceName, getBatteryLevel, onBatteryChange, OS_NAME } from '../modules/DeviceInfo';

export function DeviceScreen() {
  const [name, setName] = useState('');
  const [battery, setBattery] = useState(0);

  useEffect(() => {
    getDeviceName().then(setName);
    getBatteryLevel().then(setBattery);

    const unsubscribe = onBatteryChange(({ level }) => {
      setBattery(level);
    });

    return unsubscribe; // 组件卸载时自动清理
  }, []);

  return (
    <View>
      <Text>OS: {OS_NAME}</Text>
      <Text>Device: {name}</Text>
      <Text>Battery: {(battery * 100).toFixed(0)}%</Text>
    </View>
  );
}
```

---

## 五、数据类型映射

JS 和原生之间传递数据时，类型会自动转换：

| JavaScript | Android (Java/Kotlin) | iOS (Objective-C/Swift) |
|-----------|----------------------|------------------------|
| `boolean` | `Boolean` | `NSNumber (BOOL)` / `Bool` |
| `number` | `Double` | `NSNumber` / `Double` |
| `string` | `String` | `NSString` / `String` |
| `Array` | `ReadableArray` | `NSArray` / `[Any]` |
| `Object` | `ReadableMap` | `NSDictionary` / `[String: Any]` |
| `Promise` | `Promise` 参数 | `RCTPromiseResolveBlock + RejectBlock` |
| `Function` (callback) | `Callback` | `RCTResponseSenderBlock` |
| `null` | `null` | `NSNull` / `nil` |

---

## 六、新架构：TurboModules 写法

新架构通过 Codegen 从 JS Spec 自动生成原生接口，保证类型安全。

**Step 1：定义 JS Spec（代替手动桥接）**

```typescript
// src/specs/NativeDeviceInfo.ts
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  // 同步导出常量
  getConstants(): {
    osName: string;
  };

  // 异步方法
  getDeviceName(): Promise<string>;
  getBatteryLevel(): Promise<number>;

  // 事件相关
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DeviceInfo');
```

**Step 2：运行 Codegen**

```bash
# Codegen 会根据 Spec 自动生成：
# - Android: Java 接口 + JNI 绑定
# - iOS: ObjC++ 协议 + C++ 类型
npx react-native codegen
```

**Step 3：原生端实现生成的接口**

Codegen 会生成抽象类/协议，原生端只需实现具体逻辑：

```kotlin
// Android: 继承生成的 NativeDeviceInfoSpec
class DeviceInfoModule(reactContext: ReactApplicationContext)
    : NativeDeviceInfoSpec(reactContext) {

    override fun getName() = "DeviceInfo"

    override fun getDeviceName(promise: Promise) {
        promise.resolve(Build.MODEL)
    }

    override fun getBatteryLevel(promise: Promise) {
        // ... 同上
    }
}
```

**新架构 vs 旧架构对比：**

```
旧架构流程：
JS 调用 → JSON 序列化 → Bridge 队列 → JSON 反序列化 → 原生执行
                        ↑ 异步，有延迟

新架构流程：
JS 调用 → JSI (C++ 指针) → 原生执行
          ↑ 同步可选，零序列化
```

---

## 七、原生 UI 组件桥接

除了功能模块，还可以把原生 View 暴露给 RN。

### Android 示例：桥接原生地图 View

```kotlin
// 1. ViewManager：管理原生 View 的创建和属性
class NativeMapViewManager : SimpleViewManager<MapView>() {
    override fun getName() = "NativeMapView"

    override fun createViewInstance(context: ThemedReactContext): MapView {
        return MapView(context)
    }

    // @ReactProp 注解将 JS props 映射到原生属性
    @ReactProp(name = "zoomLevel", defaultInt = 10)
    fun setZoomLevel(view: MapView, zoomLevel: Int) {
        view.setZoom(zoomLevel)
    }

    @ReactProp(name = "center")
    fun setCenter(view: MapView, center: ReadableMap) {
        val lat = center.getDouble("latitude")
        val lng = center.getDouble("longitude")
        view.setCenter(lat, lng)
    }
}
```

```tsx
// 2. JS 端封装
import { requireNativeComponent } from 'react-native';

interface NativeMapProps {
  zoomLevel?: number;
  center?: { latitude: number; longitude: number };
  style?: ViewStyle;
}

const NativeMapView = requireNativeComponent<NativeMapProps>('NativeMapView');

export function MapView({ lat, lng, zoom = 10 }) {
  return (
    <NativeMapView
      style={{ flex: 1 }}
      zoomLevel={zoom}
      center={{ latitude: lat, longitude: lng }}
    />
  );
}
```

---

## 八、常见踩坑与调试

### 8.1 线程问题

```
⚠️ 第一大坑：UI 操作必须在主线程

// Android：错误 ❌
@ReactMethod
fun showToast(message: String) {
    Toast.makeText(context, message, Toast.LENGTH_SHORT).show() // 崩溃！
}

// Android：正确 ✅
@ReactMethod
fun showToast(message: String) {
    UiThreadUtil.runOnUiThread {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }
}

// iOS：正确 ✅
@objc func showAlert(_ title: String) {
    DispatchQueue.main.async {
        // UIKit 操作必须在主线程
    }
}
```

### 8.2 模块未找到

```
Error: TurboModuleRegistry: DeviceInfo not found

排查清单：
1. Android: MainApplication 中是否注册了 Package？
2. iOS: .m 桥接文件是否添加到 Xcode 工程？
3. 模块名是否一致？（getName() 返回值 = JS 端引用名）
4. 是否重新编译？（原生改动必须重新 build，不能热更新）
5. iOS: 是否执行了 pod install？
```

### 8.3 调试工具

| 工具 | 用途 |
|------|------|
| **Flipper** | RN 官方调试器，可查看 Bridge 消息、网络、布局 |
| **Android Studio Logcat** | 查看 Android 原生日志 (`Log.d`) |
| **Xcode Console** | 查看 iOS 原生日志 (`print / NSLog`) |
| **Chrome DevTools** | JS 层调试（新架构推荐用 Hermes debugger） |
| `adb logcat \| grep ReactNative` | 过滤 RN 相关原生日志 |

### 8.4 性能建议

```
1. 减少跨桥调用频率
   ❌ 每帧都调原生方法（如动画）
   ✅ 用 Animated API 或 Reanimated（在 UI 线程直接运行）

2. 批量传递数据
   ❌ 循环调用 100 次 addItem()
   ✅ 一次传递 addItems([...100 items])

3. 大数据考虑流式传递
   ❌ 一次传 10MB JSON
   ✅ 分片传递或用文件路径传递

4. 新架构优先
   TurboModules 懒加载 → 启动时间减少
   JSI 同步调用 → 消除序列化开销
```

---

## 九、知识图谱总结

```
前端开发者学原生模块路线：

TypeScript 基础 ──→ RN 桥接原理 ──→ 写 JS Spec
                         │
                    ┌────┴────┐
                    ▼         ▼
              Android 端   iOS 端
              ┌────────┐  ┌────────┐
              │ Kotlin  │  │ Swift  │
              │ 基本语法 │  │ 基本语法│
              ├────────┤  ├────────┤
              │Activity │  │UIKit   │
              │Context  │  │生命周期 │
              │线程模型  │  │GCD     │
              ├────────┤  ├────────┤
              │Module   │  │Module  │
              │Package  │  │.m 桥接  │
              │注册流程  │  │注册流程 │
              └────────┘  └────────┘
                    │         │
                    └────┬────┘
                         ▼
                   JS 封装 + 类型
                         │
                         ▼
                   React 组件消费
```

**学习优先级建议：**

1. 先理解桥接原理（第三节），知道 JS 和原生如何通信
2. 跟着第四节写一个完整的原生模块（两端都写一遍）
3. 了解新架构 TurboModules（第六节），这是趋势
4. 原生语言不需要精通，能读懂 + 能改 + 能调试即可
