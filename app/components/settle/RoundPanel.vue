<script setup lang="ts">
import type { RoundPreviewBlock } from '~~/shared/types';
import { CURRENCY_LABEL } from '~~/shared/money';

/**
 * 「本次要結算」面板。自動註冊名稱是 <SettleRoundPanel>。
 *
 * 一個幣別一塊(一個回合只結一個幣別,日幣台幣永不相加),由上到下就是使用者的動線:
 *   ① 明細   今晚要結的是哪幾筆(還沒列入任何回合的支出)
 *   ② 結果   A → B ¥N,按下結算會真的記下來的那些
 *   ③ 公費   任一端是公費的腿 —— 唯讀,現在不轉
 *   ④ 動作   結算這一輪(後面還有一次確認)
 *
 * ══ 這個面板最容易被誤解的一件事 ═══════════════════════════════
 *
 * **①的範圍和②的範圍刻意不同。**
 *   ① = 還沒列入任何回合的支出
 *   ② = 整趟到現在的淨額結果(含公費)
 * 只把未結的子集拿來算會重複要錢(完整理由見 server/utils/ledger.ts:
 * settlement 這一列沒有欄位指向它清掉的是哪一筆債)。
 * 所以文案必須明講這件事 —— 不然使用者會拿①的金額去驗②,發現對不起來就不信任這個 App。
 *
 * 另外,**「結算」是單階段的**:關閉回合等於宣告那些錢已經付了,沒有「之後再標記已付」。
 * 所以按鈕旁邊要先講清楚,真正的宣告留給頁面的確認面板。
 */
const props = withDefaults(defineProps<{
  block: RoundPreviewBlock;
  /** member_id -> 名字。由 useTrip 的 memberMap 傳進來 */
  names: Map<string, string>;
  /** 公費的 member_id;這趟沒設公費時是 null */
  potId?: string | null;
  /** 公費成員的名字(使用者可能取名「共同基金」而不是「公費」) */
  potName?: string;
  /** 這個幣別正在送出結算 */
  closing?: boolean;
  /** 別的地方正在寫入(結算 / 撤銷 / 標記還款)→ 鎖住,避免同時關兩輪 */
  disabled?: boolean;
}>(), {
  potId: null,
  potName: '公費',
  closing: false,
  disabled: false,
});

const emit = defineEmits<{
  /** 使用者按下「結算這一輪」。確認面板與 POST 由頁面負責 —— 寫入集中在一處 */
  close: [];
}>();

const label = computed(() => CURRENCY_LABEL[props.block.currency] ?? props.block.currency);

const items = computed(() => props.block.items ?? []);
/** item_count 由 server 算,和 items.length 應該一致;以 server 的為準 */
const itemCount = computed(() => props.block.item_count ?? items.value.length);
const recorded = computed(() => props.block.recorded ?? []);
const deferred = computed(() => props.block.deferred ?? []);

/** 沒有新明細、也沒有待轉帳 —— server 這時會回 409,所以按鈕要先鎖起來 */
const nothingToDo = computed(() => itemCount.value === 0 && recorded.value.length === 0);
const blocked = computed(() => props.block.blocked_reason ?? null);
const canClose = computed(() => !blocked.value && !nothingToDo.value);

/** 明細可以收起來:對過帳之後那一長串就只是佔位置 */
const detailOpen = ref(true);

/**
 * 有明細但算下來沒有人要轉帳(例如每個人都剛好付了自己那份,
 * 或全部的債都落在公費身上)。這種情況結算仍然有意義 —— 它把明細蓋章、
 * 讓下一輪從乾淨的地方開始 —— 但按鈕文案不能讓人以為有錢要轉。
 */
const stampOnly = computed(() => itemCount.value > 0 && recorded.value.length === 0);
</script>

<template>
  <section class="card overflow-hidden" :aria-label="`${label}本次要結算`">
    <header class="head">
      <div class="min-w-0 flex-1">
        <h4 class="text-sm font-semibold">本次要結算</h4>
        <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-[var(--text-muted)]">
          <!-- 沒東西可結的時候不要宣告「會是第 N 次」—— 那一輪根本不會發生 -->
          <template v-if="nothingToDo">【{{ label }}】</template>
          <template v-else>
            【{{ label }}】這一輪會是第 <span class="tnum">{{ block.seq }}</span> 次結算
          </template>
        </p>
      </div>
      <span v-if="!nothingToDo" class="seq-badge tnum">第 {{ block.seq }} 次</span>
    </header>

    <div class="space-y-4 p-4">
      <!-- ── 被擋住:寧可不結也不要寫入錯的金額 ── -->
      <p v-if="blocked" class="blocked">
        <Icon
          name="lucide:shield-alert"
          size="16"
          class="mt-px shrink-0"
          style="color: var(--debit)"
          aria-hidden="true"
        />
        <span>{{ blocked }}</span>
      </p>

      <!--
        ── 完全沒事可做 ──
        「沒有要結算的東西」和「公費還有錢」是兩件事。所以只有在
        **連公費的腿都沒有**的時候才整塊換成空狀態 ——
        不然信封裡的現金會在畫面上無聲消失(③ 原本被包在 v-else 裡就是這個 bug)。
      -->
      <UiEmptyState
        v-if="nothingToDo"
        dense
        icon="lucide:coffee"
        title="這個幣別目前沒有要結算的東西"
        :description="deferred.length
          ? `沒有還沒列入結算的${label}明細,也沒有人需要轉帳。剩下的都是${potName}的部分(見下面),旅程結束再處理。`
          : `沒有還沒列入結算的${label}明細,也沒有人需要轉帳。再記一筆共同花費,這裡就會出現下一輪。`"
      />

      <template v-if="!nothingToDo">
        <!-- ═════ ① 明細 ═════ -->
        <section>
          <div class="sect-head">
            <h5 class="sect-title">
              <Icon name="lucide:receipt-text" size="13" aria-hidden="true" />
              <span>要列入的明細</span>
              <span class="sect-count tnum">{{ itemCount }} 筆</span>
            </h5>
            <button
              v-if="itemCount"
              type="button"
              class="toggle"
              :aria-expanded="detailOpen"
              :aria-controls="`round-items-${block.currency}`"
              @click="detailOpen = !detailOpen"
            >
              <Icon
                name="lucide:chevron-down"
                size="13"
                class="transition-transform duration-200"
                :class="detailOpen ? '' : '-rotate-90'"
                aria-hidden="true"
              />
              {{ detailOpen ? '收起明細' : '展開明細' }}
            </button>
          </div>

          <template v-if="itemCount">
            <div v-show="detailOpen" :id="`round-items-${block.currency}`" class="mt-2">
              <SettleRoundItemList
                :items="items"
                :currency="block.currency"
                :names="names"
                :pot-id="potId"
              />
            </div>
          </template>

          <p v-else class="hint">
            這個幣別沒有新的明細 —— 下面的轉帳是之前結算後還沒還完的部分。
          </p>
        </section>

        <!-- ═════ ② 結果 ═════ -->
        <section class="topline">
          <h5 class="sect-title">
            <Icon name="lucide:arrow-left-right" size="13" aria-hidden="true" />
            <span>結算結果</span>
            <span v-if="recorded.length" class="sect-count tnum">{{ recorded.length }} 筆轉帳</span>
          </h5>

          <template v-if="recorded.length">
            <SettleRoundTransferList
              :transfers="recorded"
              :currency="block.currency"
              :names="names"
              :pot-id="potId"
              tone="recorded"
              class="mt-2"
            />
            <p class="hint">
              金額是把<strong class="font-medium text-[var(--text)]">整趟到現在</strong>的帳
              (含公費)一起抵銷後的結果,不是上面那幾筆的加總 ——
              只算未結的那一小段會重複要錢,所以刻意不那樣算。
              筆數是已簡化的組合,金額一定對得上,但不保證是筆數最少的組法。
            </p>
          </template>

          <p v-else-if="stampOnly" class="hint mt-1">
            算下來沒有人需要轉帳給別人
            <template v-if="deferred.length">(要處理的都落在{{ potName }}身上,見下面一段)</template>
            <template v-else>—— 每個人付的和該分攤的剛好對得上</template>。
            結算仍然有意義:它會把上面
            <span class="tnum">{{ itemCount }}</span> 筆標記成「已列入第
            <span class="tnum">{{ block.seq }}</span> 次結算」,下一輪就從還沒標記的地方開始。
          </p>
        </section>
      </template>

      <!--
        ═════ ③ 公費的腿:唯讀 ═════
        刻意放在 v-if 之外:不管這一輪有沒有東西要結,信封裡的現金都要看得見。
      -->
      <section v-if="deferred.length" :class="nothingToDo ? '' : 'topline'">
        <h5 class="sect-title">
          <Icon name="lucide:piggy-bank" size="13" aria-hidden="true" />
          <span>{{ potName }}的部分</span>
          <span class="sect-readonly">唯讀 · 現在不轉</span>
        </h5>

        <SettleRoundTransferList
          :transfers="deferred"
          :currency="block.currency"
          :names="names"
          :pot-id="potId"
          tone="deferred"
          class="mt-2"
        />

        <p class="hint">
          這幾筆<strong class="font-medium text-[var(--text)]">不會</strong>被結算寫進帳,
          也沒有「標記已還款」可以按。原因很實際:今晚{{ potName }}的淨額就等於<strong
            class="font-medium text-[var(--text)]"
          >信封裡還剩的現金</strong>,照著轉等於把{{ potName }}清空退還 —— 而那筆錢明天還要用。
          旅程結束時到「總覽」用<strong class="font-medium text-[var(--text)]">投入 / 退還</strong>把剩下的現金分回去,這幾筆就會歸零。
        </p>
      </section>

      <!-- ═════ ④ 動作 ═════ -->
      <div v-if="!nothingToDo" class="topline">
        <UiAppButton
          block
          icon="lucide:stamp"
          :loading="closing"
          :disabled="disabled || !canClose"
          @click="emit('close')"
        >
          結算這一輪(第 {{ block.seq }} 次)
        </UiAppButton>

        <p class="hint mt-2 text-center">
          <template v-if="blocked">先把上面的問題修好才能結算。</template>
          <template v-else>
            按下去會把
            <span class="tnum">{{ itemCount }}</span> 筆明細標記成「已列入第
            <span class="tnum">{{ block.seq }}</span> 次結算」<template
              v-if="recorded.length"
            >,並記下上面 <span class="tnum">{{ recorded.length }}</span> 筆轉帳</template>。下一步會再確認一次。
          </template>
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 顏色一律走 main.css 的變數,深色模式自動跟著換 */
.head {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: var(--bg-sunken);
  border-bottom: 1px solid var(--border);
}
.seq-badge {
  flex-shrink: 0;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 600;
  background: color-mix(in oklab, var(--brand) 14%, transparent);
  color: var(--brand);
}

.sect-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.sect-title {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-muted);
}
.sect-count {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 500;
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
}
/* 唯讀徽章要用警示色而不是品牌色 —— 它的意思是「別碰」 */
.sect-readonly {
  padding: 0.0625rem 0.375rem;
  border-radius: 999px;
  font-size: 0.625rem;
  font-weight: 500;
  background: color-mix(in oklab, var(--warn) 20%, transparent);
  color: var(--text);
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-height: 32px;
  padding-inline: 0.5rem;
  margin-right: -0.5rem;
  border-radius: 0.5rem;
  font-size: 0.6875rem;
  color: var(--text-muted);
  transition: background-color 0.15s ease, color 0.15s ease;
}
@media (hover: hover) {
  .toggle:hover {
    background: var(--bg-sunken);
    color: var(--text);
  }
}

.topline {
  padding-top: 0.875rem;
  border-top: 1px solid var(--border);
}

.hint {
  margin-top: 0.5rem;
  font-size: 0.6875rem;
  line-height: 1.6;
  color: var(--text-muted);
}

.blocked {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem;
  border-radius: 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.6;
  background: color-mix(in oklab, var(--debit) 10%, transparent);
  border: 1px solid color-mix(in oklab, var(--debit) 35%, var(--border));
  color: var(--text);
}

@media (prefers-reduced-motion: reduce) {
  .toggle {
    transition: none;
  }
}
</style>
