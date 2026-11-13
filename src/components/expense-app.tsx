"use client";

import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";
import type { RecordModel } from "pocketbase";
import {
    ArrowDownLeft,
    ArrowDownRight,
    ArrowRight,
    ArrowUpRight,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Download,
    FolderOpen,
    LayoutDashboard,
    Loader2,
    LogOut,
    Menu,
    Plus,
    RefreshCw,
    Search,
    Settings,
    Target,
    Wallet,
    Users,
    X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { MonthPicker } from "./month-picker";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "./ui/select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "./ui/alert-dialog";
import { useAuth } from "./auth-provider";
import { SignIn } from "./sign-in";
import { Brand } from "./brand";
import { UserAvatar } from "./user-avatar";
import { CategoryIcon } from "./category-icon";
import { ExpenseEditor } from "./expense-editor";
import { ExpenseDetails } from "./expense-details";
import { TransactionSort } from "./transaction-sort";
import { Transactions } from "./transactions";
import { CategoryBreakdown } from "./category-breakdown";
import { EmptyState } from "./empty-state";
import { BudgetEditor } from "./budget-editor";
import { SpendingChart } from "./spending-chart";
import { WorkspaceContext } from "./workspace-context";
import { WorkspaceTheme } from "./workspace-theme";
import { WorkspaceSettings } from "./workspace-settings";
import { CirclesView } from "./circles/circles-view";
import { MoveExpenseDialog } from "./circles/move-expense-dialog";
import { CircleInvitationGate } from "./circles/circle-invitation";
import { CircleTransactionDialog } from "./circles/circle-transaction-dialog";
import { pb } from "@/lib/pocketbase";
import { downloadExpenses, type ExportFormat } from "@/lib/export";
import { categoryLabel,
    errorMessage,
    money,
    monthBounds,
    monthTitle,
    rateDate,
    EMPTY_RATES,
    type WorkspaceConfig,
    type ExchangeRates,
    zonedDate,
    type Budget,
    type Expense,
    type ExpenseInput,
    type Overview,
    type Preferences,
    type Transaction,
    type TransactionPage,
    type CircleTransaction,
} from "@/lib/domain";

function transactionPage(params: URLSearchParams, page: number, perPage = 15) {
    return pb.send<TransactionPage>(`/api/expenditure/transactions?${new URLSearchParams({ ...Object.fromEntries(params), page: String(page), perPage: String(perPage) })}`, { method: "GET" });
}

type Section =
    | "Overview" |
    "Transactions" |
    "Categories" |
    "Budgets" |
    "Circles" |
    "Settings";
const navigation = [
    { name: "Overview", icon: LayoutDashboard },
    { name: "Transactions", icon: ArrowDownLeft },
    { name: "Spending", icon: FolderOpen },
    { name: "Circles", icon: Users },
] as const;
function subscribeDesktop(callback: () => void) {
    const media = window.matchMedia("(min-width: 1024px)");
    media.addEventListener("change", callback);
    return () => media.removeEventListener("change", callback);
}

const blank: Overview = {
    total: 0,
    income: 0,
    income_missing_count: 0,
    count: 0,
    previous: 0,
    categories: [],
    activity: [],
    missing_count: 0,
    previous_missing_count: 0,
    missing_currencies: [],
    currency: "SGD",
    original_totals: [],
};

function StartupLoading() {
    return (
        <main className="grid min-h-svh place-items-center px-6">
            <div className="flex flex-col items-center gap-6" role="status" aria-label="Loading workspace">
                <Brand />
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
        </main>
    );
}

export function ExpenseApp() {
    const { user, ready, signOut } = useAuth();
    if (!ready) return <StartupLoading />;
    if (!user) return <SignIn />;
    return <AccountWorkspace key={user.id} user={user} onSignOut={signOut} />;
}

function AccountWorkspace({
    user,
    onSignOut,
}: {
    user: RecordModel;
    onSignOut: () => void;
}) {
    const [configuration, setConfiguration] = useState<WorkspaceConfig | null>(
        null,
    );
    const [error, setError] = useState("");
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        let active = true;
        async function load() {
            try {
                const status = await pb.send<{ version: number }>("/api/expenditure/status", { method: "GET" });
                if (typeof status.version !== "number" || status.version < 44)
                    throw new Error("This app requires backend version 44. Install the latest PocketBase migrations and hooks.");
                const result = await pb.send<WorkspaceConfig>(
                    "/api/expenditure/config",
                    { method: "GET" },
                );
                if (active) {
                    setConfiguration(result);
                    setError("");
                }
            } catch (e) {
                if (active) setError(errorMessage(e));
            }
        }

        void load();
        return () => {
            active = false;
        };
    }, [revision]);
    if (!configuration && !error) return <StartupLoading />;
    if (!configuration)
        return (
            <main className="flex min-h-svh flex-col items-center justify-center px-6">
                <Brand />
                <div className="mt-10 max-w-md text-center">
                    <h1 className="font-display text-3xl font-semibold tracking-[-0.7px]">Backend unavailable</h1>
                    <p className="mt-4 text-sm leading-7 text-muted-foreground">
                        The Expenditure API is not available yet. Install this project’s
                        PocketBase migrations and hooks, then restart PocketBase.
                    </p>
                    <p role="alert" className="mt-4 text-xs text-destructive">
                        {error}
                    </p>
                    <div className="mt-6 flex justify-center gap-3">
                        <Button
                            onClick={() => {
                                setError("");
                                setRevision((r) => r + 1);
                            }}>
                            <RefreshCw /> Try again
                        </Button>
                        <Button variant="ghost" onClick={onSignOut}>
                            Sign out
                        </Button>
                    </div>
                </div>
            </main>
        );
    return (
        <Workspace
            user={user}
            initialConfiguration={configuration}
            onSignOut={onSignOut}
        />
    );
}

function Workspace({
    user,
    initialConfiguration,
    onSignOut,
}: {
    user: RecordModel;
    initialConfiguration: WorkspaceConfig;
    onSignOut: () => void;
}) {
    const [section, setSection] = useState<Section>(initialConfiguration.preferences.default_tab);
    const [spendingSection, setSpendingSection] = useState<"Categories" | "Budgets">(initialConfiguration.preferences.default_tab === "Budgets" ? "Budgets" : "Categories");
    const [settingsDirty, setSettingsDirty] = useState(false);
    const [settingsSaving, setSettingsSaving] = useState(false);
    const [leavingSettings, setLeavingSettings] = useState<Section | null>(null);
    const [focusedCircle, setFocusedCircle] = useState<string>();
    const [configuration, setConfiguration] = useState(initialConfiguration);
    const preferences = configuration.preferences;
    const [rates, setRates] = useState<ExchangeRates>(EMPTY_RATES);
    const [currency, setCurrency] = useState("all");
    const mainCurrency = preferences.currency;
    const filterCurrency = section === "Transactions" ? currency : "all";
    const [month, setMonth] = useState(() =>
        zonedDate(new Date(), initialConfiguration.preferences.timezone).slice(
            0,
            7,
        ),
    );
    const [mobileNav, setMobileNav] = useState(false);
    const [editor, setEditor] = useState<Expense | "new" | "income" | null>(null);
    const [viewing, setViewing] = useState<Expense | null>(null);
    const [deleting, setDeleting] = useState<Expense | null>(null);
    const [moving, setMoving] = useState<Expense | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [budgetEditor, setBudgetEditor] = useState<Budget | "new" | null>(null);
    const [overview, setOverview] = useState<Overview>(blank);
    const [expenses, setExpenses] = useState<Transaction[]>([]);
    const [circleTransaction, setCircleTransaction] = useState<CircleTransaction | null>(null);
    const [budgets, setBudgets] = useState<Budget[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [category, setCategory] = useState("all");
    const [transactionSort, setTransactionSort] = useState("date_desc");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [exporting, setExporting] = useState(false);
    const [revision, setRevision] = useState(0);
    const desktop = useSyncExternalStore(
        subscribeDesktop,
        () => window.matchMedia("(min-width: 1024px)").matches,
        () => false,
    );
    const timezone = preferences.timezone;
    const name = String(user.name || user.email || "Account");
    const refresh = useCallback(() => setRevision((r) => r + 1), []);
    const range = useMemo(() => monthBounds(month, timezone), [month, timezone]);
    const reloadConfiguration = useCallback(async () => {
        const result = await pb.send<WorkspaceConfig>("/api/expenditure/config", {
            method: "GET",
        });
        setConfiguration(result);
    }, []);
    const categoryOptions = configuration.categories.map((item) => ({ id: item.id, name: item.name }));
    const showCircleTransactions = (section === "Overview" || section === "Transactions") && preferences.show_circle_transactions;
    if (showCircleTransactions && !categoryOptions.some((item) => item.name.trim().toLowerCase() === "other")) categoryOptions.push({ id: "unmapped", name: "Other" });
    const transactionParams = useMemo(() => new URLSearchParams({ from: range.from, to: range.to, currency: filterCurrency, category, search: debouncedSearch.trim(), sort: section === "Transactions" ? transactionSort : "date_desc" }), [range, filterCurrency, category, debouncedSearch, section, transactionSort]);
    const visibleCurrencies = Array.from(
        new Set([...preferences.currencies, ...configuration.used_currencies]),
    ).sort();
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(1);
        }, 220);
        return () => clearTimeout(timer);
    }, [search]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") setMobileNav(false);
            if (
                event.key.toLowerCase() === "n" &&
                section !== "Circles" &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !["INPUT", "TEXTAREA", "SELECT"].includes(
                    (event.target as HTMLElement).tagName,
                ) &&
                !document.querySelector("[role=\"dialog\"]")
            ) {
                event.preventDefault();
                setEditor("new");
            }
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [section]);
    useEffect(() => {
        const onFocus = () => {
            refresh();
            void reloadConfiguration().catch(() => {});
        };

        window.addEventListener("focus", onFocus);
        const subscription = pb
            .collection("expenses")
            .subscribe("*", () => refresh());
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") refresh();
        }, 300000);
        const preferencesSubscription = pb.collection("preferences").subscribe(configuration.preferences.id, () => {
            void reloadConfiguration().catch(() => {});
        });
        preferencesSubscription.catch(() => {});
        subscription.catch(() => {}); // Focus refresh remains available if realtime is blocked.
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", onFocus);
            void subscription.then((unsubscribe) => unsubscribe()).catch(() => {});
            void preferencesSubscription.then((unsubscribe) => unsubscribe()).catch(() => {});
        };
    }, [refresh, reloadConfiguration, configuration.preferences.id]);
    useEffect(() => {
        let active = true;
        async function load() {
            setLoading(true);
            setError("");
            try {
                if (showCircleTransactions) await reloadConfiguration();
                const snapshot = await pb.send<ExchangeRates>(
                    "/api/expenditure/rates",
                    { method: "GET" },
                );
                if (active) setRates(snapshot);
                const params = new URLSearchParams({
                    ...range,
                    currency: filterCurrency,
                });
                const [summary, records, limits] = await Promise.all([
                    pb.send<Overview>(`/api/expenditure/overview?${params}`, {
                        method: "GET",
                    }),
                    transactionPage(transactionParams, page),
                    pb.collection<Budget>("budgets").getFullList({
                        expand: "category",
                        filter: pb.filter("month = {:month} && currency = {:currency}", {
                            month,
                            currency: mainCurrency,
                        }),
                    }),
                ]);
                if (active) {
                    setOverview(summary);
                    setExpenses(records.items);
                    setTotal(records.totalItems);
                    if (page > Math.max(1, records.totalPages))
                        setPage(Math.max(1, records.totalPages));
                    setBudgets(limits);
                }
            } catch (e) {
                if (active) setError(errorMessage(e));
            } finally {
                if (active) setLoading(false);
            }
        }

        void load();
        return () => {
            active = false;
        };
    }, [
        section,
        month,
        filterCurrency,
        mainCurrency,
        timezone,
        category,
        debouncedSearch,
        page,
        range,
        revision,
        showCircleTransactions,
        transactionParams,
        reloadConfiguration,
    ]);

    function navigate(next: Section, discardSettings = false) {
        if (section === "Settings" && settingsDirty && next !== "Settings" && !discardSettings) {
            setLeavingSettings(next);
            setMobileNav(false);
            return;
        }

        setSection(next);
        if (next === "Categories" || next === "Budgets") setSpendingSection(next);
        setMobileNav(false);
        setSearch("");
        setCurrency("all");
        setCategory("all");
        setPage(1);
    }

    function changeMonth(next: string) {
        if (/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/.test(next)) {
            setMonth(next);
            setPage(1);
        }
    }

    async function saveExpense(data: ExpenseInput, id?: string) {
        if (id) await pb.collection("expenses").update(id, data);
        else
            await pb
                .collection("expenses")
                .create({ ...data, user: user.id, source: "manual" });
        refresh();
        toast.success(`${data.kind === "income" ? "Income" : "Expense"} ${id ? "updated" : "added"}`);
    }

    async function deleteExpense() {
        if (!deleting) return;
        setDeleteBusy(true);
        try {
            await pb.collection("expenses").delete(deleting.id);
            refresh();
            setDeleting(null);
            if (expenses.length === 1 && page > 1) setPage(page - 1);
            toast.success(`${deleting.kind === "income" ? "Income" : "Expense"} deleted`);
        } catch (e) {
            toast.error(errorMessage(e));
        } finally {
            setDeleteBusy(false);
        }
    }

    async function saveBudget(
        data: { category: string; amount: number },
        existing?: Budget,
    ) {
        if (
            budgets.some((b) => b.category === data.category && b.id !== existing?.id)
        ) {
            throw new Error(
                "A budget already exists for this category. Edit it instead.",
            );
        }

        if (existing) await pb.collection("budgets").update(existing.id, data);
        else
            await pb
                .collection("budgets")
                .create({ ...data, currency: mainCurrency, month, user: user.id });
        refresh();
        toast.success("Budget saved");
    }

    async function removeBudget(budget: Budget) {
        await pb.collection("budgets").delete(budget.id);
        refresh();
        toast.success("Budget removed");
    }

    async function exportExpenses(format: ExportFormat) {
        setExporting(true);
        try {
            const rows: Transaction[] = [];
            let current = 1, pages = 1;
            do {
                const result = await transactionPage(transactionParams, current, 100);
                rows.push(...result.items);
                pages = result.totalPages;
                current++;
            } while (current <= pages);

            await downloadExpenses(rows, {
                format,
                month,
                currency: filterCurrency,
                timezone,
                timeFormat: preferences.time_format,
                mainCurrency,
                rates,
            });
            toast.success(`Exported ${rows.length} transactions`);
        } catch (e) {
            toast.error(errorMessage(e));
        } finally {
            setExporting(false);
        }
    }

    const overall = budgets.find((b) => b.category === "");
    const remaining = overall ? overall.amount - overview.total : null;
    const foreignCurrencies = overview.original_totals
        .map((item) => item.currency)
        .filter((code) => code !== mainCurrency);
    const rateDates = foreignCurrencies
        .map((code) => rateDate(code, mainCurrency, rates))
        .filter(Boolean)
        .sort();
    const firstRateDate = rateDates[0];
    const lastRateDate = rateDates.at(-1);
    const rateDateLabel = firstRateDate === lastRateDate ?
        firstRateDate :
        `${firstRateDate} – ${lastRateDate}`;
    const today = zonedDate(new Date(), timezone);
    const elapsed =
        month === today.slice(0, 7) ?
                Number(today.slice(8)) :
                new Date(
                    Number(month.slice(0, 4)),
                    Number(month.slice(5)),
                    0,
                ).getDate();
    const difference =
        overview.previous > 0 &&
        !overview.previous_missing_count &&
        !overview.missing_count ?
                ((overview.total - overview.previous) / overview.previous) * 100 :
            null;
    const isDataPage = [
        "Overview",
        "Transactions",
        "Categories",
        "Budgets",
    ].includes(section);
    const isSpending = section === "Categories" || section === "Budgets";
    const sectionTitle = isSpending ? "Spending" : section;
    return (
        <WorkspaceContext.Provider value={{ ...configuration, rates }}>
            <WorkspaceTheme theme={preferences.theme} userId={user.id} />
            <div className="min-h-svh">
                {mobileNav && (
                    <button
                        className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
                        aria-label="Close navigation"
                        onClick={() => setMobileNav(false)}
                    />
                )}
                <aside
                    inert={!desktop && !mobileNav}
                    aria-hidden={!desktop && !mobileNav}
                    className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r bg-card px-5 py-8 transition-transform duration-250 lg:translate-x-0 ${mobileNav ? "translate-x-0" : "-translate-x-full"}`}>
                    <div className="mb-11 px-1">
                        <Brand compact />
                    </div>
                    <p className="eyebrow mb-4 px-3 text-[9px]">Workspace</p>
                    <nav aria-label="Main navigation" className="space-y-1">
                        {navigation.map(({ name: label, icon: Icon }) => (
                            <button
                                key={label}
                                aria-current={(label === "Spending" ? isSpending : section === label) ? "page" : undefined}
                                onClick={() => navigate(label === "Spending" ? spendingSection : label)}
                                className={`group flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[13px] font-medium transition-colors ${(label === "Spending" ? isSpending : section === label) ? "bg-primary/9 text-primary" : "text-muted-foreground hover:bg-white/3 hover:text-foreground"}`}>
                                <Icon className="size-4" strokeWidth={1.5} />
                                {label}
                                {(label === "Spending" ? isSpending : section === label) && (
                                    <span className="ml-auto size-1 rounded-full bg-primary" />
                                )}
                            </button>
                        ))}
                    </nav>
                    <div className="mt-auto pt-12">
                        <button
                            onClick={() => navigate("Settings")}
                            className={`flex h-10 w-full items-center gap-3 rounded-xl px-3 text-[13px] font-medium ${section === "Settings" ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                            <Settings className="size-4" strokeWidth={1.5} />
                            Settings
                        </button>
                        <div className="mt-5 border-t pt-5">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button className="flex w-full items-center gap-3 rounded-lg px-1 text-left">
                                        <UserAvatar user={user} name={name} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-xs">{name}</span>
                                        </span>
                                        <ChevronDown className="size-3 text-muted-foreground" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent side="top" align="start" className="w-48">
                                    <DropdownMenuItem onClick={onSignOut}>
                                        <LogOut />
                                        Sign out
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>
                </aside>
                <div inert={!desktop && mobileNav} className="lg:pl-60">
                    <header className="flex h-18 items-center justify-between border-b px-5 sm:px-9 xl:px-12">
                        <div className="flex items-center gap-3">
                            <button
                                className="lg:hidden"
                                aria-label="Open navigation"
                                onClick={() => setMobileNav(true)}>
                                <Menu className="size-5" />
                            </button>
                            <span className="hidden text-[11px] text-muted-foreground sm:inline">
                                Personal workspace
                            </span>
                            <span className="hidden text-xs text-muted-foreground/35 sm:inline">
                                /
                            </span>
                            <span className="text-[11px] text-foreground/80">{sectionTitle}</span>
                        </div>
                        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Settings" onClick={() => navigate("Settings")}><Settings /></Button>
                    </header>
                    <main
                        id="main-content"
                        className="mx-auto max-w-355 px-5 py-7 sm:px-9 sm:py-9 xl:px-12">
                        <div className="mb-9 flex flex-wrap items-end justify-between gap-5">
                            <div>
                                <h1 className="font-display text-[34px] leading-tight font-semibold tracking-[-0.7px] sm:text-[38px]">
                                    {sectionTitle}
                                </h1>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {isDataPage && (
                                    <>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button
                                                    variant="outline"
                                                    aria-label="Export transactions"
                                                    className="h-10 px-3.5"
                                                    disabled={exporting || loading || !!error}>
                                                    {exporting ?
                                                            (
                                                                <Loader2 className="animate-spin" />
                                                            ) :
                                                            (
                                                                <Download />
                                                            )}
                                                    <span className="hidden sm:inline">Export</span>
                                                    <ChevronDown className="size-3" />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-max max-w-(--radix-dropdown-menu-content-available-width) whitespace-nowrap">
                                                <DropdownMenuItem
                                                    onClick={() => void exportExpenses("xlsx")}>
                                                    Excel (.xlsx)
                                                </DropdownMenuItem>
                                                <DropdownMenuItem
                                                    onClick={() => void exportExpenses("csv")}>
                                                    CSV (Google Sheets)
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                        <Button variant="outline" className="h-10 px-3 text-xs sm:px-4 sm:text-sm" onClick={() => setEditor("income")}>
                                            <Plus className="hidden sm:block" /> Add income
                                        </Button>
                                        <Button
                                            className="h-10 px-3 text-xs sm:px-4 sm:text-sm"
                                            onClick={() => setEditor("new")}>
                                            <Plus className="hidden sm:block" /> Add expense
                                        </Button>
                                    </>
                                )}
                            </div>
                        </div>
                        {isSpending && (
                            <div className="mb-6 flex gap-5 border-b" role="group" aria-label="Spending sections">
                                {(["Categories", "Budgets"] as const).map((item) => (
                                    <button key={item} onClick={() => navigate(item)} aria-pressed={section === item} className={`border-b-2 py-3 text-xs transition-colors ${section === item ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{item}</button>
                                ))}
                            </div>
                        )}
                        {isDataPage && (
                            <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
                                <MonthPicker value={month} onChange={changeMonth} timezone={preferences.timezone} />
                                {section === "Transactions" ?
                                        (
                                            <Select
                                                value={currency}
                                                onValueChange={(value) => {
                                                    setCurrency(value);
                                                    setPage(1);
                                                }}>
                                                <SelectTrigger
                                                    aria-label="Filter currency"
                                                    className="h-10! min-w-30 text-xs">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All currencies</SelectItem>
                                                    {visibleCurrencies.map((code) => (
                                                        <SelectItem key={code} value={code}>
                                                            {code}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        ) :
                                        (
                                            <span className="text-[11px] text-muted-foreground">
                                                Main currency · {mainCurrency}
                                            </span>
                                        )}
                            </div>
                        )}
                        {isDataPage && overview.missing_count > 0 && (
                            <p
                                role="alert"
                                className="mb-5 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-xs leading-6 text-destructive">
                                {overview.missing_count} expenses have no usable conversion rate
                                ({overview.missing_currencies.join(", ")}). Converted totals are
                                incomplete.
                            </p>
                        )}
                        {isDataPage && foreignCurrencies.length > 0 && (
                            <p className="mb-5 text-[10px] leading-5 text-muted-foreground">
                                Estimated conversions
                                {rateDateLabel ?
                                    ` · rates dated ${rateDateLabel}.` :
                                    "."}
                                {rates.stale ?
                                    " Rates are unavailable or the cache is stale." :
                                    ""}
                            </p>
                        )}
                        {isDataPage && error && (
                            <div
                                role="alert"
                                className="mb-7 rounded-xl border border-destructive/20 bg-destructive/5 p-5">
                                <p className="text-sm text-destructive">
                                    Couldn’t load transactions.
                                </p>
                                <p className="mt-2 text-xs text-muted-foreground">{error}</p>
                                <Button variant="outline" className="mt-4" onClick={refresh}>
                                    <RefreshCw />
                                    Try again
                                </Button>
                            </div>
                        )}
                        {isDataPage && loading && (
                            <div
                                className="flex items-center gap-2 pb-4 text-xs text-muted-foreground"
                                role="status">
                                <Loader2 className="size-3.5 animate-spin" />
                                Loading…
                            </div>
                        )}
                        {section === "Overview" && !error && (
                            <div
                                className={`animate-enter transition-opacity ${loading ? "opacity-40" : "opacity-100"}`}>
                                <section className="mb-9 grid gap-7 border-b pb-9 md:grid-cols-[1.2fr_1fr] xl:grid-cols-[1fr_1.2fr]">
                                    <div>
                                        <p className="eyebrow">
                                            {overview.missing_count ?
                                                "Converted subtotal" :
                                                "Total spent"}{" "}
                                            <span className="ml-1 tracking-normal text-muted-foreground/50">
                                                / {mainCurrency}
                                            </span>
                                        </p>
                                        <div className="mt-3 flex items-baseline gap-2">
                                            <span className="text-[clamp(44px,5vw,64px)] leading-none tracking-[-2px] tabular-nums">
                                                {money(overview.total, mainCurrency)}
                                            </span>
                                        </div>
                                        <p className="mt-4 text-xs text-primary">Income {money(overview.income, mainCurrency)} · Net {money(overview.income - overview.total, mainCurrency)}</p>
                                        {overview.income_missing_count > 0 && <p className="mt-2 text-xs text-destructive">{overview.income_missing_count} income entries have no usable conversion rate.</p>}
                                        <div className="mt-4 flex items-center gap-2 text-[10px]">
                                            {difference !== null ?
                                                    (
                                                        <>
                                                            <span
                                                                className={`flex items-center gap-1 rounded-full px-2 py-1 ${difference <= 0 ? "bg-primary/8 text-primary" : "bg-destructive/8 text-destructive"}`}>
                                                                {difference <= 0 ?
                                                                        (
                                                                            <ArrowDownRight className="size-3" />
                                                                        ) :
                                                                        (
                                                                            <ArrowUpRight className="size-3" />
                                                                        )}
                                                                {Math.abs(difference).toFixed(1)}%
                                                            </span>
                                                            <span className="text-muted-foreground">
                                                                vs. last month
                                                            </span>
                                                        </>
                                                    ) :
                                                    (
                                                        <span className="text-muted-foreground">
                                                            {overview.previous_missing_count ?
                                                                "Previous-month conversion incomplete" :
                                                                overview.count ?
                                                                    "No previous-month data" :
                                                                    "No expenses this month"}
                                                        </span>
                                                    )}
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-5 self-center md:border-l md:pl-8">
                                        <div>
                                            <p className="eyebrow text-[9px]">
                                                {remaining !== null ?
                                                    "Budget remaining" :
                                                    "Monthly budget"}
                                            </p>
                                            <p
                                                className={`mt-3 text-[24px] font-medium tabular-nums tracking-[-0.5px] ${remaining !== null && remaining < 0 ? "text-destructive" : "text-foreground/90"}`}>
                                                {remaining !== null ?
                                                        money(remaining, mainCurrency) :
                                                    "Not set"}
                                            </p>
                                            {overall ?
                                                    (
                                                        <div className="mt-3 h-1 max-w-35 overflow-hidden rounded-full bg-white/5">
                                                            <div
                                                                className="h-full rounded-full bg-primary/65 transition-all duration-500"
                                                                style={{
                                                                    width: `${Math.min(100, (overview.total / overall.amount) * 100)}%`,
                                                                }}
                                                            />
                                                        </div>
                                                    ) :
                                                    (
                                                        <button
                                                            onClick={() => {
                                                                navigate("Budgets");
                                                                setBudgetEditor("new");
                                                            }}
                                                            className="mt-3 flex items-center gap-1 text-[10px] text-primary">
                                                            Set a budget <ArrowRight className="size-3" />
                                                        </button>
                                                    )}
                                        </div>
                                        <div>
                                            <p className="eyebrow text-[9px]">Daily average</p>
                                            <p className="mt-3 text-[24px] font-medium tabular-nums tracking-[-0.5px]">
                                                {money(
                                                    Math.round(overview.total / elapsed),
                                                    mainCurrency,
                                                )}
                                            </p>
                                            <p className="mt-3 text-[10px] text-muted-foreground">
                                                Across {elapsed} calendar days
                                            </p>
                                        </div>
                                        <div className="col-span-2 flex items-center gap-2 pt-1 text-[10px] text-muted-foreground">
                                            <span className="flex size-5 items-center justify-center rounded-full bg-white/4">
                                                <Wallet className="size-2.5" />
                                            </span>
                                            {overview.count} expenses this month{preferences.include_circle_in_budgets ? ", including Circle shares" : ""}
                                            <span className="mx-1 text-white/15">·</span>
                                            {mainCurrency} · converted total
                                        </div>
                                    </div>
                                </section>
                                <div className="grid gap-8 border-b pb-8 xl:grid-cols-[1.65fr_1fr]">
                                    <section className="min-w-0">
                                        <div className="mb-2 flex items-center justify-between">
                                            <h2 className="text-sm font-medium">Spending activity</h2>
                                            <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                                                <span className="size-1.5 rounded-full bg-primary" />
                                                Daily spending
                                            </span>
                                        </div>
                                        <SpendingChart
                                            overview={overview}
                                            month={month}
                                            timezone={timezone}
                                            currency={mainCurrency}
                                        />
                                    </section>
                                    <section className="xl:border-l xl:pl-8">
                                        <div className="mb-6 flex items-center justify-between">
                                            <h2 className="text-sm font-medium">By category</h2>
                                            <button
                                                onClick={() => navigate("Categories")}
                                                aria-label="View all categories"
                                                className="text-muted-foreground hover:text-primary">
                                                <ArrowUpRight className="size-4" />
                                            </button>
                                        </div>
                                        <CategoryBreakdown
                                            overview={overview}
                                            currency={mainCurrency}
                                            compact
                                        />
                                    </section>
                                </div>
                                <section className="pt-8">
                                    <div className="mb-5 flex items-center justify-between">
                                        <h2 className="text-sm font-medium">Recent transactions</h2>
                                        <button
                                            onClick={() => navigate("Transactions")}
                                            className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary">
                                            View all <ArrowRight className="size-3" />
                                        </button>
                                    </div>
                                    <Transactions
                                        rows={expenses.slice(0, 5)}
                                        onView={setViewing}
                                        onCircle={setCircleTransaction}
                                        timezone={timezone}
                                        onEdit={setEditor}
                                        onDelete={setDeleting}
                                        onMove={setMoving}
                                        emptyAction={() => setEditor("new")}
                                    />
                                </section>
                            </div>
                        )}
                        {section === "Transactions" && (
                            <section className="animate-enter">
                                <div className="mb-6 flex flex-wrap gap-3">
                                    <div className="relative min-w-50 flex-1">
                                        <Search className="absolute top-3 left-3 size-3.5 text-muted-foreground" />
                                        <Input
                                            aria-label="Search transactions"
                                            maxLength={200}
                                            value={search}
                                            onChange={(e) => setSearch(e.target.value)}
                                            placeholder={showCircleTransactions ? "Search merchants, Circles, notes…" : "Search merchants, notes, payment methods…"}
                                            className="h-10 pr-10 pl-9 text-xs"
                                        />
                                        {search && (
                                            <button
                                                className="absolute top-1 right-1 flex size-8 items-center justify-center rounded-md transition-colors hover:bg-muted"
                                                aria-label="Clear search"
                                                onClick={() => setSearch("")}>
                                                <X className="size-3.5 text-muted-foreground" />
                                            </button>
                                        )}
                                    </div>
                                    <Select
                                        value={category}
                                        onValueChange={(value) => {
                                            setCategory(value);
                                            setPage(1);
                                        }}>
                                        <SelectTrigger
                                            aria-label="Filter category"
                                            className="h-10! w-44 text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="all">All categories</SelectItem>
                                            {categoryOptions.map((c) => (
                                                <SelectItem key={c.id} value={c.id}>
                                                    {c.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <TransactionSort
                                        value={transactionSort}
                                        onChange={(value) => {
                                            setTransactionSort(value);
                                            setPage(1);
                                        }}
                                    />
                                </div>
                                {transactionSort.startsWith("amount_") && filterCurrency === "all" && <p className="mb-4 text-xs text-muted-foreground">Amounts in original currencies</p>}
                                {!error && (
                                    <Transactions
                                        rows={expenses}
                                        onView={setViewing}
                                        onCircle={setCircleTransaction}
                                        timezone={timezone}
                                        onEdit={setEditor}
                                        onDelete={setDeleting}
                                        onMove={setMoving}
                                        emptyAction={() => setEditor("new")}
                                        filtered={!!debouncedSearch || category !== "all"}
                                    />
                                )}
                                <div className="mt-5 flex items-center justify-between text-[10px] text-muted-foreground">
                                    <span>
                                        {total} {total === 1 ? "transaction" : "transactions"}
                                    </span>
                                    <div className="flex items-center gap-3">
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            disabled={page <= 1 || loading}
                                            aria-label="Previous page"
                                            onClick={() => setPage(page - 1)}>
                                            <ChevronLeft />
                                        </Button>
                                        <span>
                                            {page} / {Math.max(1, Math.ceil(total / 15))}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            disabled={page * 15 >= total || loading}
                                            aria-label="Next page"
                                            onClick={() => setPage(page + 1)}>
                                            <ChevronRight />
                                        </Button>
                                    </div>
                                </div>
                            </section>
                        )}
                        {section === "Categories" && !error && (
                            <section className="animate-enter">
                                <div className="mb-8 flex items-baseline justify-between border-b pb-6">
                                    <div>
                                        <h2 className="text-sm">
                                            {overview.categories.length} categories this month
                                        </h2>
                                        <button
                                            className="mt-2 text-xs text-primary"
                                            onClick={() => navigate("Settings")}>
                                            Manage categories
                                        </button>
                                    </div>
                                    <span className="text-sm text-muted-foreground">
                                        {money(overview.total, mainCurrency)}
                                    </span>
                                </div>
                                <div className="max-w-3xl">
                                    <CategoryBreakdown
                                        overview={overview}
                                        currency={mainCurrency}
                                    />
                                </div>
                            </section>
                        )}
                        {section === "Budgets" && !error && (
                            <section className="animate-enter">
                                <div className="mb-6 flex items-center justify-between border-b pb-5">
                                    <h2 className="text-sm">
                                        Monthly limits{" "}
                                        <span className="ml-2 text-xs text-muted-foreground">
                                            {budgets.length} set
                                        </span>
                                    </h2>
                                    <Button
                                        variant="outline"
                                        className="h-9"
                                        onClick={() => setBudgetEditor("new")}>
                                        <Plus />
                                        Add budget
                                    </Button>
                                </div>
                                {budgets.length ?
                                        (
                                            <div className="divide-y">
                                                {[...budgets]
                                                    .sort((a, b) =>
                                                        a.category === "" ?
                                                                -1 :
                                                            b.category === "" ?
                                                                1 :
                                                                    categoryLabel(a).localeCompare(categoryLabel(b)),
                                                    )
                                                    .map((budget) => {
                                                        const spent =
                                                            budget.category === "" ?
                                                                overview.total :
                                                                overview.categories.find(
                                                                    (c) => c.category === budget.category,
                                                                )?.total || 0;
                                                        const percent = (spent / budget.amount) * 100;
                                                        return (
                                                            <button
                                                                key={budget.id}
                                                                onClick={() => setBudgetEditor(budget)}
                                                                className="grid w-full gap-4 py-6 text-left transition-colors hover:bg-white/1 sm:grid-cols-[1fr_1fr] sm:gap-10">
                                                                <div className="flex items-center gap-4">
                                                                    {budget.category === "" ?
                                                                            (
                                                                                <span className="flex size-10 items-center justify-center rounded-xl border bg-primary/5 text-primary">
                                                                                    <Target className="size-4" />
                                                                                </span>
                                                                            ) :
                                                                            (
                                                                                <CategoryIcon category={categoryLabel(budget)} />
                                                                            )}
                                                                    <div>
                                                                        <p className="text-sm">
                                                                            {budget.category === "" ?
                                                                                "Monthly spending" :
                                                                                    categoryLabel(budget)}
                                                                        </p>
                                                                        <p className="mt-1 text-[10px] text-muted-foreground">
                                                                            {money(budget.amount, mainCurrency)}{" "}
                                                                            budget
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                                <div className="self-center">
                                                                    <div className="mb-2.5 flex justify-between text-xs">
                                                                        <span
                                                                            className={
                                                                                percent > 100 ?
                                                                                    "text-destructive" :
                                                                                    "text-foreground"
                                                                            }>
                                                                            {money(spent, mainCurrency)}{" "}
                                                                            <span className="text-muted-foreground">
                                                                                spent
                                                                            </span>
                                                                        </span>
                                                                        <span className="text-muted-foreground">
                                                                            {Math.round(percent)}%
                                                                        </span>
                                                                    </div>
                                                                    <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                                                                        <div
                                                                            className={`h-full rounded-full transition-all duration-500 ${percent > 100 ? "bg-destructive/70" : "bg-primary/70"}`}
                                                                            style={{
                                                                                width: `${Math.min(100, percent)}%`,
                                                                            }}
                                                                        />
                                                                    </div>
                                                                    <p className="mt-2 text-[10px] text-muted-foreground">
                                                                        {money(
                                                                            Math.abs(budget.amount - spent),
                                                                            mainCurrency,
                                                                        )}{" "}
                                                                        {percent > 100 ?
                                                                            "over budget" :
                                                                            "left to spend"}
                                                                    </p>
                                                                </div>
                                                            </button>
                                                        );
                                                    })}
                                            </div>
                                        ) :
                                        (
                                            <EmptyState
                                                icon="budget"
                                                title="No budgets"
                                                detail="Set an overall limit or a budget for an individual category."
                                            />
                                        )}
                                <p className="mt-8 text-[10px] leading-6 text-muted-foreground">
                                    Budgets apply to {monthTitle(month)} in {mainCurrency}.
                                    {preferences.include_circle_in_budgets && " Your allocated Circle expense shares are included. Circle categories without a matching personal category count as Other."}{" "}
                                    Category limits are independent of the overall budget and do
                                    not roll over.
                                </p>
                            </section>
                        )}
                        {section === "Circles" && (
                            <CirclesView
                                key={focusedCircle || "circles"}
                                initialCircle={focusedCircle}
                                month={month}
                                onMonthChange={changeMonth}
                                onTransactionMoved={() => {
                                    void reloadConfiguration().catch(() => {});
                                    refresh();
                                }}
                            />
                        )}
                        {section === "Settings" && (
                            <WorkspaceSettings
                                onEditRecurring={setEditor}
                                onDirtyChange={setSettingsDirty}
                                key={preferences.id || "defaults"}
                                recurringRevision={revision}
                                onSave={async (data) => {
                                    setSettingsSaving(true);
                                    try {
                                        if (preferences.id)
                                            await pb
                                                .collection<Preferences>("preferences")
                                                .update(preferences.id, data);
                                        else
                                            await pb
                                                .collection<Preferences>("preferences")
                                                .create({ ...data, user: user.id });
                                        await reloadConfiguration();
                                        refresh();
                                        toast.success("Preferences saved");
                                    } finally {
                                        setSettingsSaving(false);
                                    }
                                }}
                                onCategoriesChanged={async () => {
                                    await reloadConfiguration();
                                    refresh();
                                }}
                            />
                        )}
                    </main>
                </div>
                {viewing && (
                    <ExpenseDetails
                        expense={viewing}
                        onClose={() => setViewing(null)}
                        onEdit={() => {
                            setViewing(null);
                            setEditor(viewing);
                        }}
                        onDelete={() => {
                            setViewing(null);
                            setDeleting(viewing);
                        }}
                    />
                )}
                {circleTransaction && (
                    <CircleTransactionDialog
                        transaction={circleTransaction}
                        onClose={() => setCircleTransaction(null)}
                        onOpenCircle={(id) => {
                            setCircleTransaction(null);
                            setFocusedCircle(id);
                            navigate("Circles");
                        }}
                    />
                )}
                <CircleInvitationGate onJoined={(id) => {
                    setFocusedCircle(id);
                    navigate("Circles");
                }}
                />
                {moving && (
                    <MoveExpenseDialog
                        expense={moving}
                        onClose={() => setMoving(null)}
                        onMoved={(circle) => {
                            refresh();
                            void reloadConfiguration();
                            setFocusedCircle(circle);
                            navigate("Circles");
                            toast.success("Expense moved to Circle");
                        }}
                    />
                )}
                {editor && (
                    <ExpenseEditor
                        key={typeof editor === "string" ? editor : editor.id}
                        expense={typeof editor === "string" ? null : editor}
                        kind={editor === "income" ? "income" : "expense"}
                        currency={mainCurrency}
                        timezone={timezone}
                        onClose={() => setEditor(null)}
                        onSave={saveExpense}
                        onMove={(expense) => {
                            setEditor(null);
                            setMoving(expense);
                        }}
                    />
                )}
                {budgetEditor && (
                    <BudgetEditor
                        budget={budgetEditor === "new" ? null : budgetEditor}
                        month={month}
                        currency={mainCurrency}
                        onClose={() => setBudgetEditor(null)}
                        onSave={saveBudget}
                        onDelete={removeBudget}
                    />
                )}
                <AlertDialog open={leavingSettings !== null} onOpenChange={(open) => { if (!open) setLeavingSettings(null); }}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
                            <AlertDialogDescription>Your preference changes haven’t been saved. Discard them to open {leavingSettings}.</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Keep editing</AlertDialogCancel>
                            <AlertDialogAction
                                disabled={settingsSaving}
                                onClick={() => {
                                    if (leavingSettings) navigate(leavingSettings, true);
                                    setLeavingSettings(null);
                                }}>Discard and leave
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
                <AlertDialog
                    open={!!deleting}
                    onOpenChange={(open) => {
                        if (!open && !deleteBusy) setDeleting(null);
                    }}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Delete this {deleting?.kind || "entry"}?</AlertDialogTitle>
                            <AlertDialogDescription>
                                {deleting?.merchant} ·{" "}
                                {deleting && money(deleting.amount, deleting.currency)}.
                                This removes the entry permanently.{deleting?.recurrence ? " Future recurring entries will stop. Existing entries will remain." : ""}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel disabled={deleteBusy}>
                                Keep entry
                            </AlertDialogCancel>
                            <AlertDialogAction
                                disabled={deleteBusy}
                                onClick={(e) => {
                                    e.preventDefault();
                                    void deleteExpense();
                                }}>
                                {deleteBusy ? "Deleting…" : "Delete entry"}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        </WorkspaceContext.Provider>
    );
}
