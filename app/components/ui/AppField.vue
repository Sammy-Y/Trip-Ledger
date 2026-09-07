<script setup lang="ts" generic="T extends string | number | null">
/**
 * 表單欄位。自動註冊名稱是 <UiAppField>。
 *
 * label + 控件 + 提示 / 錯誤 一次包好,所有表單長得一樣。
 * 支援 v-model:
 *   <UiAppField v-model="desc" label="項目" placeholder="例:一蘭拉麵" />
 *   <UiAppField v-model="amount" label="金額" type="number" :step="0.01" hint="日幣直接填 13244" />
 *   <UiAppField v-model="currency" label="幣別" type="select" :options="currencyOptions" />
 *
 * type="number" 會 emit number(空白時 emit null),不會 emit 字串,
 * 所以拿去算合計不用再 Number() 一次。
 */
const props = withDefaults(defineProps<{
  /** 欄位標籤。不給就不顯示 label(例如放在 table 裡) */
  label?: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'textarea';
  placeholder?: string;
  /** 說明文字,顯示在欄位下方。有 error 時會被 error 蓋掉 */
  hint?: string;
  /** 錯誤訊息。有值時邊框變紅並顯示訊息 */
  error?: string | null;
  /** type="select" 用的選項 */
  options?: Array<{ value: string | number; label: string }>;
  /** select 的空值選項文字。不給就沒有空選項 */
  placeholderOption?: string;
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  /** 手機鍵盤類型。type="number" 預設 'decimal' */
  inputmode?: 'text' | 'decimal' | 'numeric' | 'tel' | 'email' | 'search' | 'url' | 'none';
  step?: number | string;
  min?: number | string;
  max?: number | string;
  /** textarea 行數 */
  rows?: number;
  autocomplete?: string;
  autofocus?: boolean;
  /** 金額類欄位設 true:文字靠右 + 等寬數字,欄位不會跳動 */
  numeric?: boolean;
}>(), {
  label: undefined,
  type: 'text',
  placeholder: undefined,
  hint: undefined,
  error: null,
  options: undefined,
  placeholderOption: undefined,
  required: false,
  disabled: false,
  readonly: false,
  inputmode: undefined,
  step: undefined,
  min: undefined,
  max: undefined,
  rows: 3,
  autocomplete: undefined,
  autofocus: false,
  numeric: false,
});

/**
 * v-model。型別跟著父層的變數走(泛型),所以 typecheck 不會噪。
 * type="number" 請把父層宣告成 `number | null`(清空欄位時會寫入 null)。
 */
const model = defineModel<T>({ required: true });

const fieldId = useId();
const describedById = computed(() => `${fieldId}-desc`);

/** 數字欄位在手機上要跳出數字鍵盤 */
const resolvedInputmode = computed(
  () => props.inputmode ?? (props.type === 'number' ? 'decimal' : undefined),
);

/** 金額欄位靠右 + 等寬 */
const alignClass = computed(() => (props.numeric || props.type === 'number' ? 'text-right tnum' : ''));

const controlClass = computed(() => [
  'field',
  alignClass.value,
  props.error ? 'border-[var(--debit)]' : '',
  props.disabled ? 'opacity-50' : '',
]);

function onInput(e: Event) {
  const el = e.target as HTMLInputElement | HTMLTextAreaElement;
  if (props.type === 'number') {
    // 空字串 -> null(而不是 0),表單才能區分「還沒填」和「填了 0」
    const n = el.value === '' ? null : Number(el.value);
    model.value = (Number.isNaN(n) ? null : n) as T;
    return;
  }
  model.value = el.value as T;
}

/**
 * select 刻意走 v-model 而不是 :value + @change。
 * options 是非同步載入的時候(例如成員名單要等 API),v-model 的 updated hook
 * 會在 <option> 重新渲染後重新套用選取狀態;:value 不會,畫面會和資料脫鉤。
 */
const selectModel = computed<string | number>({
  get: () => (model.value ?? '') as string | number,
  set: (v) => {
    model.value = v as T;
  },
});
</script>

<template>
  <div class="w-full">
    <label v-if="label" :for="fieldId" class="label">
      {{ label }}
      <span v-if="required" class="ml-0.5" style="color: var(--debit)">*</span>
    </label>

    <!-- select:拿掉原生箭頭自己畫,才不會在 iOS / Android 上長不一樣 -->
    <div v-if="type === 'select'" class="relative">
      <select
        :id="fieldId"
        v-model="selectModel"
        :disabled="disabled"
        :required="required"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="(error || hint) ? describedById : undefined"
        :class="[...controlClass, 'appearance-none pr-10']"
      >
        <option v-if="placeholderOption" value="" disabled>{{ placeholderOption }}</option>
        <option v-for="opt in options ?? []" :key="String(opt.value)" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <Icon
        name="lucide:chevron-down"
        size="18"
        class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
      />
    </div>

    <textarea
      v-else-if="type === 'textarea'"
      :id="fieldId"
      :value="model ?? ''"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      :required="required"
      :autofocus="autofocus"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="(error || hint) ? describedById : undefined"
      :class="[...controlClass, 'py-2.5 leading-relaxed resize-y']"
      @input="onInput"
    />

    <div v-else class="relative">
      <input
        :id="fieldId"
        :type="type"
        :value="model ?? ''"
        :placeholder="placeholder"
        :disabled="disabled"
        :readonly="readonly"
        :required="required"
        :inputmode="resolvedInputmode"
        :step="step"
        :min="min"
        :max="max"
        :autocomplete="autocomplete"
        :autofocus="autofocus"
        :aria-invalid="error ? 'true' : undefined"
        :aria-describedby="(error || hint) ? describedById : undefined"
        :class="[...controlClass, $slots.suffix ? 'pr-14' : '']"
        @input="onInput"
      >
      <!-- suffix slot:放幣別符號 / 單位這種東西 -->
      <div
        v-if="$slots.suffix"
        class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-muted)]"
      >
        <slot name="suffix" />
      </div>
    </div>

    <p
      v-if="error"
      :id="describedById"
      class="mt-1.5 flex items-start gap-1 text-xs"
      style="color: var(--debit)"
    >
      <Icon name="lucide:circle-alert" size="14" class="mt-px shrink-0" />
      <span>{{ error }}</span>
    </p>
    <p
      v-else-if="hint"
      :id="describedById"
      class="mt-1.5 text-xs text-[var(--text-muted)]"
    >
      {{ hint }}
    </p>
  </div>
</template>

<style scoped>
/* 數字欄位的上下小箭頭在記帳表單裡只會誤觸(而且和右對齊的金額擠在一起很醜),拿掉 */
input[type='number']::-webkit-outer-spin-button,
input[type='number']::-webkit-inner-spin-button {
  appearance: none;
  margin: 0;
}
input[type='number'] {
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>
