<script setup lang="ts">
/**
 * 登入 / 註冊。
 *
 * 一頁兩用而不是兩個路由:使用者在這裡的心智是「我要進去」,
 * 「我是新的還是舊的」是次要的分支,切頁面反而讓人重打一次 email。
 *
 * ⚠️ 帳號**不是**用這個 App 的必要條件 —— 拿到分享連結的旅伴不用註冊就能記帳。
 * 帳號解決的是另一件事:換手機之後還找得回自己的旅程。頁面上要把這點講清楚,
 * 否則使用者會以為自己被擋在門外。
 */
definePageMeta({ layout: false });

const auth = useAuth();
const route = useRoute();

type Mode = 'login' | 'register';
const mode = ref<Mode>((route.query.mode === 'register' ? 'register' : 'login') as Mode);

const form = reactive({ email: '', password: '', display_name: '' });
const busy = ref(false);
const errorMessage = ref<string | null>(null);

/** 登入後要回哪裡。預設回首頁,但從旅程頁被導過來時要回得去。 */
const redirectTo = computed(() => {
  const to = route.query.redirect;
  const path = Array.isArray(to) ? to[0] : to;
  // 只接受站內路徑 —— 開放重新導向(open redirect)是拿來釣魚的經典手法:
  // /login?redirect=https://evil.example 會讓我們的網域幫對方背書。
  return typeof path === 'string' && /^\/(?!\/)/.test(path) ? path : '/';
});

const title = computed(() => (mode.value === 'login' ? '登入' : '建立帳號'));
const canSubmit = computed(() => form.email.trim().length > 3 && form.password.length >= 10);

async function submit() {
  if (busy.value || !canSubmit.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    if (mode.value === 'login') await auth.login(form.email.trim(), form.password);
    else await auth.register(form.email.trim(), form.password, form.display_name.trim() || undefined);
    // 登入會換一組 session,舊的「我的旅程」快取一定要丟掉重抓
    await refreshNuxtData('trips');
    await navigateTo(redirectTo.value);
  } catch (e) {
    errorMessage.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login';
  errorMessage.value = null;
}
</script>

<template>
  <div class="min-h-dvh grid place-items-center px-4 py-10">
    <div class="w-full max-w-sm space-y-6">
      <div class="text-center space-y-1">
        <span class="grid place-items-center w-14 h-14 rounded-2xl mx-auto"
              style="background: color-mix(in oklab, var(--brand) 13%, transparent); color: var(--brand)">
          <Icon name="lucide:luggage" size="26" />
        </span>
        <h1 class="text-2xl font-bold pt-2">{{ title }}</h1>
        <p class="text-sm" style="color: var(--text-muted)">
          帳號是為了讓你換手機之後還找得回自己的旅程。
        </p>
      </div>

      <form class="card p-5 space-y-4" @submit.prevent="submit">
        <UiAppField
          v-model="form.email" label="Email" type="email"
          placeholder="you@example.com" autocomplete="email" required autofocus />

        <UiAppField
          v-if="mode === 'register'" v-model="form.display_name"
          label="顯示名稱" placeholder="不填就用 email 的前半段"
          autocomplete="nickname" />

        <UiAppField
          v-model="form.password" label="密碼" type="password"
          :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
          :hint="mode === 'register' ? '至少 10 個字' : undefined"
          required />

        <p v-if="errorMessage" class="text-sm" style="color: var(--debit)">{{ errorMessage }}</p>

        <UiAppButton type="submit" variant="primary" block :loading="busy" :disabled="!canSubmit">
          {{ title }}
        </UiAppButton>
      </form>

      <div class="text-center text-sm space-y-3">
        <p>
          <span style="color: var(--text-muted)">
            {{ mode === 'login' ? '還沒有帳號?' : '已經有帳號了?' }}
          </span>
          <button type="button" class="ml-1 font-medium" style="color: var(--brand)" @click="switchMode">
            {{ mode === 'login' ? '建立一個' : '改用登入' }}
          </button>
        </p>
        <p class="pt-1">
          <NuxtLink to="/" class="text-sm" style="color: var(--text-muted)">
            <Icon name="lucide:arrow-left" class="inline" size="14" />
            不用帳號也能記帳
          </NuxtLink>
        </p>
      </div>
    </div>
  </div>
</template>
