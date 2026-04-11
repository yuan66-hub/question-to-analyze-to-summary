# 多按钮点击事件优化：事件委托

## 问题背景

页面上有多个按钮，分别响应不同的点击事件，逐个绑定监听器会导致内存占用高、动态元素需重新绑定等问题。

## 原生 JS：事件委托

### 核心思路

利用事件冒泡机制，将多个子元素的事件监听统一绑定到父元素上。

### 优化前

```js
document.getElementById('btn1').addEventListener('click', handleBtn1);
document.getElementById('btn2').addEventListener('click', handleBtn2);
document.getElementById('btn3').addEventListener('click', handleBtn3);
// N 个按钮 = N 个监听器
```

### 优化后

```html
<div id="button-container">
  <button data-action="save">保存</button>
  <button data-action="delete">删除</button>
  <button data-action="edit">编辑</button>
</div>
```

```js
document.getElementById('button-container').addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const actions = {
    save: handleSave,
    delete: handleDelete,
    edit: handleEdit,
  };

  actions[target.dataset.action]?.();
});
```

### 优势对比

| 对比项 | 逐个绑定 | 事件委托 |
|--------|---------|---------|
| 监听器数量 | N 个 | 1 个 |
| 内存占用 | 随按钮数线性增长 | 固定 |
| 动态元素 | 需手动重新绑定 | 自动生效 |
| 解绑维护 | 逐个移除 | 移除一个即可 |

### 注意事项

1. **用 `closest()` 而非 `e.target`** — 按钮内有子元素（如 icon）时，`e.target` 可能是子元素
2. **不适用于不冒泡的事件** — `focus`/`blur` 不冒泡，需用 `focusin`/`focusout` 替代
3. **`stopPropagation` 会破坏委托** — 子元素阻止冒泡后委托失效，慎用

---

## React 中的处理

> React 底层已将事件委托到 root 节点，但组件层面仍需注意避免重复创建函数。

### 问题写法：每次渲染创建 N 个新函数

```jsx
{buttons.map(btn => (
  <button onClick={() => handleClick(btn.id)}> {/* 每次 render 新建函数 */}
    {btn.label}
  </button>
))}
```

### 方案一：data 属性 + 单一处理函数

```jsx
const handleClick = useCallback((e) => {
  const action = e.currentTarget.dataset.action;
  // 根据 action 分发逻辑
}, []);

return (
  <div>
    {buttons.map(btn => (
      <button key={btn.id} data-action={btn.action} onClick={handleClick}>
        {btn.label}
      </button>
    ))}
  </div>
);
```

### 方案二：父级委托（大量按钮时）

```jsx
const handleClick = useCallback((e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const actions = { save: doSave, delete: doDelete, edit: doEdit };
  actions[target.dataset.action]?.();
}, []);

return (
  <div onClick={handleClick}>
    {buttons.map(btn => (
      <button key={btn.id} data-action={btn.action}>{btn.label}</button>
    ))}
  </div>
);
```

---

## Vue 中的处理

> Vue 模板编译器会对事件处理做静态优化。

### 直接传参（Vue 模板编译优化）

```vue
<button v-for="btn in buttons" :key="btn.id" @click="handleClick(btn.id)">
  {{ btn.label }}
</button>
```

> Vue 模板中 `@click="handleClick(btn.id)"` 会被编译器静态优化，不等同于 JSX 中的箭头函数，无需额外处理。

### 父级委托（大量列表项）

```vue
<template>
  <div @click="handleClick">
    <button v-for="btn in buttons" :key="btn.id" :data-action="btn.action">
      {{ btn.label }}
    </button>
  </div>
</template>

<script setup>
const handleClick = (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const actions = { save: doSave, delete: doDelete, edit: doEdit };
  actions[target.dataset.action]?.();
};
</script>
```

---

## 适用场景总结

| 场景 | 推荐方式 |
|------|---------|
| 按钮 < 20 个 | 框架默认写法即可 |
| 按钮 20~100+ | 父级委托，减少 vDOM diff |
| 长列表每行有操作按钮 | 父级委托，配合虚拟滚动 |
| 按钮静态不变 | 无需优化 |

## 核心结论

- **原生 JS**：事件委托是标准优化手段，利用冒泡 + `closest()` 实现
- **React**：箭头函数在 `map` 中每次创建新引用，大列表用 `data-*` + 单一 handler 优化
- **Vue**：模板语法 `@click="fn(arg)"` 已被编译器优化，大多数场景无需额外处理
- **通用**：超大列表统一用父级事件委托
