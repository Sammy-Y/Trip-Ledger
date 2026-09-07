<script setup lang="ts">
// 這裡刻意只留最小的出口:
//   NuxtPwaManifest —— PWA manifest(加到主畫面用)
//   NuxtLayout      —— 整體外框在 app/layouts/default.vue(標頭 / 導覽 / 內容區)
//   NuxtPage        —— 各頁面
// 任何跟畫面有關的東西都不要加在這裡,否則所有頁面都會被連坐。
</script>

<template>
  <NuxtPwaManifest />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
