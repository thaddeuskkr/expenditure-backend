import type { ThemePreference } from "../../pocketbase/pb_hooks/theme-core.cjs";
import type { RecordModel } from "pocketbase";
import currencyCatalog from "../../pocketbase/pb_hooks/currencies.json" with { type: "json" };
import timezoneCatalog from "../../pocketbase/pb_hooks/timezones.json" with { type: "json" };

export const CATEGORIES = [
    "Food & drinks",
    "Groceries",
    "Transport",
    "Shopping",
    "Entertainment",
    "Bills & utilities",
    "Health",
    "Other",
] as const;
export type Category = string;
export const CURRENCY_CATALOG = currencyCatalog;
export const TIMEZONES = timezoneCatalog;
export const CATEGORY_COLORS = [
    "#d6b4d5",
    "#b5baff",
    "#b7b9cf",
    "#d6b79a",
    "#a8b6c5",
    "#e7b9c8",
    "#c3a4af",
    "#a59aaa",
];
export const DEFAULT_TABS = ["Overview", "Transactions", "Categories", "Budgets", "Circles", "Settings"] as const;
export type DefaultTab = typeof DEFAULT_TABS[number];
export type TimeFormat = "24h" | "12h";
export type Recurrence = "" | "daily" | "weekly" | "monthly" | "yearly";
export interface RecurrenceSchedule {
    recurrence: Recurrence;
    recurrence_interval: number;
    /** 0 keeps the original day; -1 means the last day of the month. */
    recurrence_day: number;
    /** ISO weekdays: Monday = 1, Sunday = 7. Empty uses the entry's weekday. */
    recurrence_weekdays: number[];
    /** Yearly month, 1–12. Zero keeps the entry's month. */
    recurrence_month: number;
}
export interface RecurringFields extends RecurrenceSchedule {
    recurrence_anchor: string;
    recurrence_next: string;
    recurrence_timezone: string;
    recurrence_error: string;
}
export const RECURRENCE_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const RECURRENCE_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function recurrenceFrequencyLabel({ recurrence, recurrence_interval: interval }: Pick<RecurrenceSchedule, "recurrence" | "recurrence_interval">) {
    if (!recurrence) return "";
    const units = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
    return interval === 1 ? recurrence[0].toUpperCase() + recurrence.slice(1) : `Every ${interval} ${units[recurrence]}s`;
}

export function recurrenceLabel(schedule: RecurrenceSchedule & { recurrence_anchor?: string }, start = schedule.recurrence_anchor) {
    const { recurrence, recurrence_day: day } = schedule;
    if (!recurrence) return "";
    const frequency = recurrenceFrequencyLabel(schedule);
    if (recurrence === "weekly") {
        const weekdays = schedule.recurrence_weekdays?.length ? schedule.recurrence_weekdays : start ? [new Date(start.slice(0, 10) + "T12:00:00Z").getUTCDay() || 7] : [];
        if (weekdays.length === 7) return frequency + " on every day";
        if (weekdays.join(",") === "1,2,3,4,5") return frequency + " on weekdays";
        return frequency + (weekdays.length ? " on " + weekdays.map((value) => RECURRENCE_WEEKDAYS[value - 1].slice(0, 3)).join(", ") : "");
    }

    const selectedDay = day || Number(start?.slice(8, 10));
    if (recurrence === "monthly") return frequency + (selectedDay ? selectedDay === -1 ? " on the last day" : ` on day ${selectedDay}` : "");
    if (recurrence === "yearly") {
        const month = schedule.recurrence_month || Number(start?.slice(5, 7));
        const lastDay = new Date(Date.UTC(2028, month, 0)).getUTCDate();
        if (month && selectedDay) return frequency + (selectedDay === -1 || selectedDay > lastDay ? ` on the last day of ${RECURRENCE_MONTHS[month - 1]}` : ` on ${selectedDay} ${RECURRENCE_MONTHS[month - 1]}`);
    }

    return frequency;
}

export interface Expense extends RecordModel, RecurringFields {
    kind: "expense" | "income";
    merchant: string;
    /** Integer currency minor units (cents for SGD). */
    amount: number;
    currency: string;
    category: Category;
    expand?: { category?: CategoryDefinition };
    occurred_at: string;
    notes: string;
    payment_method: string;
    source: "manual" | "api" | "shortcut";
}
export interface Budget extends RecordModel {
    month: string;
    /** Empty means an overall monthly budget; otherwise a personal category ID. */
    category: Category;
    expand?: { category?: CategoryDefinition };
    currency: string;
    /** Integer currency minor units (cents for SGD). */
    amount: number;
}
export interface Preferences extends RecordModel {
    theme: ThemePreference;
    default_entry_currency: string;
    default_expense_category: string;
    default_income_category: string;
    default_api_circle: string;
    include_circle_in_budgets: boolean;
    show_circle_transactions: boolean;
    default_tab: DefaultTab;
    time_format: TimeFormat;
    currency: string;
    timezone: string;
    currencies: string[];
    payment_methods: string[];
    shortcut_payment_methods: { label: string; payment_method: string }[];
    strip_wallet_merchant_location: boolean;
}

export interface CircleTransaction extends RecordModel, RecurringFields {
    kind: "expense" | "income";
    title: string;
    amount: number;
    allocated_amount: number;
    currency: string;
    category: string;
    budget_category: string;
    budget_category_name: string;
    occurred_at: string;
    notes: string;
    payment_method: string;
    source: "manual" | "api" | "shortcut";
    circle: string;
    membership_active: boolean;
    expand: { circle: { id: string; name: string; icon: string }; category?: CategoryDefinition };
}
export type Transaction = Expense | CircleTransaction;
export interface TransactionPage {
    items: Transaction[];
    page: number;
    perPage: number;
    totalItems: number;
    totalPages: number;
}
export function isCircleTransaction(row: Transaction): row is CircleTransaction {
    return row.collectionName === "circle_expenses";
}

export function transactionName(row: Transaction) {
    return isCircleTransaction(row) ? row.title : row.merchant;
}

export function transactionAmount(row: Transaction) {
    return isCircleTransaction(row) ? row.allocated_amount : row.amount;
}

export function categoryLabel(row: { expand?: { category?: { name: string } } }) {
    return row.expand?.category?.name || "Uncategorized";
}

export interface CategoryDefinition {
    id: string;
    name: string;
    color: string;
    active: boolean;
    sort_order: number;
}
export interface WorkspaceConfig {
    preferences: Preferences;
    categories: CategoryDefinition[];
    used_currencies: string[];
}
export interface ExchangeRates {
    quotes: Record<string, number>;
    dates: Record<string, string>;
    fetched_at: string;
    attempted_at: string;
    stale: boolean;
    provider: string;
    source_url: string;
}
export const EMPTY_RATES: ExchangeRates = {
    quotes: { EUR: 1 },
    dates: {},
    fetched_at: "",
    attempted_at: "",
    stale: true,
    provider: "Frankfurter",
    source_url: "https://frankfurter.dev/",
};
const MAX_RATE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export interface ApiKey {
    id: string;
    name: string;
    key_prefix: string;
    scopes: string[];
    created: string;
    expires_at: string;
    revoked_at: string;
    last_used: string;
}
export interface Overview {
    income: number;
    income_missing_count: number;
    total: number;
    count: number;
    previous: number;
    categories: { category: Category; category_name: string; total: number; count: number }[];
    activity: { occurred_at: string; total: number }[];
    missing_count: number;
    previous_missing_count: number;
    missing_currencies: string[];
    currency: string;
    original_totals: { currency: string; total: number }[];
}
export type ExpenseInput = Pick<
    Expense,
    | "kind" |
    "recurrence" |
    "recurrence_interval" |
    "recurrence_day" |
    "recurrence_weekdays" |
    "recurrence_month" |
    "merchant" |
    "amount" |
    "currency" |
    "category" |
    "occurred_at" |
    "notes" |
    "payment_method"
>;

export function money(minorUnits: number, currency = "SGD") {
    const digits = currencyDigits(currency);
    return new Intl.NumberFormat("en-SG", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    }).format(minorUnits / 10 ** digits);
}

export function currencyDigits(currency: string) {
    return CURRENCY_CATALOG.find((c) => c.code === currency)?.digits ?? 2;
}

export function formatAmountInput(amount: number, currency: string) {
    return (amount / 10 ** currencyDigits(currency)).toFixed(
        currencyDigits(currency),
    );
}

export function parseMinorUnits(value: string, currency = "SGD") {
    const digits = currencyDigits(currency);
    const pattern = new RegExp(
        `^\\d{1,11}${digits ? `(\\.\\d{1,${digits}})?` : ""}$`,
    );
    if (!pattern.test(value.trim()))
        throw new Error(
            digits ?
                `Enter an amount with up to ${digits} decimal places.` :
                "Enter a whole-number amount.",
        );
    const [whole, fraction = ""] = value.trim().split(".");
    const minorUnits =
        Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"));
    if (minorUnits < 1 || minorUnits > 99999999999)
        throw new Error(
            `Amount must be between ${formatAmountInput(1, currency)} and ${formatAmountInput(99999999999, currency)}.`,
        );
    return minorUnits;
}

export function convertAmount(
    amount: number,
    from: string,
    to: string,
    rates: ExchangeRates,
    now = Date.now(),
) {
    if (from === to) return amount;
    if (!rates.quotes[from] || !rates.quotes[to]) return null;
    const dates = [rates.dates[from], rates.dates[to]].filter(Boolean);
    if (
        !dates.length ||
        dates.some((date) => now - Date.parse(date) > MAX_RATE_AGE_MS)
    )
        return null;
    const sourceUnits = amount / 10 ** currencyDigits(from);
    const targetUnits = (sourceUnits * rates.quotes[to]) / rates.quotes[from];
    const convertedMinorUnits = Math.round(targetUnits * 10 ** currencyDigits(to));
    return Number.isSafeInteger(convertedMinorUnits) ? convertedMinorUnits : null;
}

export function rateDate(from: string, to: string, rates: ExchangeRates) {
    return [rates.dates[from], rates.dates[to]].filter(Boolean).sort()[0] || "";
}

export function zonedDate(date: Date | string, timezone = "Asia/Singapore") {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(asDate(date));
}

export function timezoneLabel(timezone: string, date: Date | string = new Date()) {
    const offset = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        timeZoneName: "longOffset",
    }).formatToParts(asDate(date)).find((part) => part.type === "timeZoneName")!.value;
    return `${offset === "GMT" ? "GMT+00:00" : offset} · ${timezone.replaceAll("_", " ")}`;
}

export function asDate(value: Date | string) {
    return value instanceof Date ? value : new Date(value.replace(" ", "T"));
}

export function pocketbaseTimestamp(value: string) {
    return asDate(value).toISOString().replace("T", " ");
}

export function zonedInput(date: Date | string, timezone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(asDate(date));
    const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function fromZonedInput(value: string, timezone: string, original?: string) {
    // An unchanged minute-only picker must preserve seconds and the selected
    // occurrence of an overlapping daylight-saving time.
    if (original && value === zonedInput(original, timezone))
        return asDate(original).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
        throw new Error("Choose a valid date and time.");
    const target = Date.parse(`${value}:00Z`);
    if (
        !Number.isFinite(target) ||
        new Date(target).toISOString().slice(0, 16) !== value
    )
        throw new Error("Choose a valid date and time.");
    let instant = target;
    for (let i = 0; i < 4; i++) {
        const represented = Date.parse(
            `${zonedInput(new Date(instant), timezone)}:00Z`,
        );
        const difference = target - represented;
        if (difference === 0) return new Date(instant).toISOString();
        instant += difference;
    }

    throw new Error(
        "This local time does not exist because of a daylight-saving change. Choose another time.",
    );
}

export function shiftMonth(month: string, shift: number) {
    const [year, number] = month.split("-").map(Number);
    return new Date(Date.UTC(year, number - 1 + shift, 1))
        .toISOString()
        .slice(0, 7);
}

export function monthBounds(month: string, timezone: string) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    function start(selected: string) {
        const day = `${selected}-01`;
        const midnight = Date.parse(`${day}T00:00:00Z`);
        let before = midnight - 36 * 60 * 60 * 1000;
        let after = midnight + 36 * 60 * 60 * 1000;
        // Find the first instant in the local month. Midnight can be skipped
        // or repeated by a timezone transition; entry-time validation stays strict.
        while (after - before > 1) {
            const middle = Math.floor((before + after) / 2);
            if (formatter.format(new Date(middle)) < day) before = middle;
            else after = middle;
        }

        return new Date(after).toISOString();
    }

    return {
        from: start(month),
        to: start(shiftMonth(month, 1)),
        previous: start(shiftMonth(month, -1)),
    };
}

export function monthTitle(month: string) {
    return new Intl.DateTimeFormat("en-SG", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    }).format(new Date(`${month}-01T00:00:00Z`));
}

export function dayLabel(date: string, timezone: string) {
    return new Intl.DateTimeFormat("en-SG", {
        day: "numeric",
        month: "short",
        timeZone: timezone,
    }).format(asDate(date));
}

export function timeLabel(date: Date | string, timezone: string, timeFormat: TimeFormat = "24h", includeSeconds = false) {
    return new Intl.DateTimeFormat("en-SG", {
        hour: timeFormat === "12h" ? "numeric" : "2-digit",
        minute: "2-digit",
        ...(includeSeconds ? { second: "2-digit" } : {}),
        hourCycle: timeFormat === "12h" ? "h12" : "h23",
        timeZone: timezone,
    }).format(asDate(date)).toUpperCase();
}

export function dateTimeLabel(date: Date | string, timezone: string, timeFormat: TimeFormat) {
    const day = new Intl.DateTimeFormat("en-SG", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: timezone,
    }).format(asDate(date));
    return `${day}, ${timeLabel(date, timezone, timeFormat, true)}`;
}

export function errorMessage(error: unknown) {
    return error instanceof Error ?
        error.message :
        "Something went wrong. Please try again.";
}
