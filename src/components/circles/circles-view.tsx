"use client";

import { TransactionSort } from "../transaction-sort";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Ellipsis, Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useWorkspace } from "../workspace-context";
import { dateTimeLabel, dayLabel, errorMessage, money, monthBounds, recurrenceLabel } from "@/lib/domain";
import { MonthPicker } from "../month-picker";
import { CategoryIcon } from "../category-icon";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import {
    circlesApi,
    canModifyCircleExpense,
    canMoveCircleExpense,
    type CircleSettlement,
    type CircleMember,
    type CircleInvitation,
    invitationLink,
    type CircleDetail,
    type CircleExpense,
    type CircleIndex,
    type SettlementSuggestion,
} from "@/lib/circles";
import { CircleIcon } from "./circle-icon";
import { CircleExpenseList } from "./circle-expense-list";
import { CircleBalances } from "./circle-balances";
import { CircleMembers } from "./circle-members";
import { CirclePermissionsDialog } from "./circle-permissions-dialog";
import {
    CircleConfirmDialog,
    CircleSettingsDialog,
    CurrencySelect,
    FormError,
    InviteDialog,
    TransferDialog,
} from "./circle-dialogs";
import { CircleCategorySettings } from "./circle-category-settings";
import { CircleExpenseEditor } from "./circle-expense-editor";
import { CircleExpenseDetails } from "./circle-expense-details";
import { MoveToPersonalDialog } from "./move-to-personal-dialog";
import { SettlementDialog } from "./settlement-dialog";

type Confirmation = {
    title: string;
    description: string;
    label: string;
    confirmationName?: string;
    action: (name: string) => Promise<void>;
};

export function CirclesView({ initialCircle, month, onMonthChange, onTransactionMoved }: { initialCircle?: string; month: string; onMonthChange: (month: string) => void; onTransactionMoved: () => void }) {
    const { preferences } = useWorkspace();
    const [index, setIndex] = useState<CircleIndex | null>(null),
        [data, setData] = useState<CircleDetail | null>(null);
    const [selected, setSelected] = useState<string | null>(initialCircle || null);
    const [tab, setTab] = useState<"Expenses" | "Balances">("Expenses");
    const [settlementPage, setSettlementPage] = useState(1);
    const [revision, setRevision] = useState(0),
        [loading, setLoading] = useState(true),
        [error, setError] = useState("");
    const [dialog, setDialog] = useState<"create" | "settings" | "categories" | "members" | "invite" | "transfer" | null>(
        null,
    );
    const [editor, setEditor] = useState<CircleExpense | "new" | "income" | null>(null),
        [viewing, setViewing] = useState<CircleExpense | null>(null);
    const [moving, setMoving] = useState<CircleExpense | null>(null);
    const [permissionMember, setPermissionMember] = useState<CircleMember | null>(null);
    const [settlement, setSettlement] = useState<SettlementSuggestion | CircleSettlement | null>(null),
        [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [filterCurrency, setFilterCurrency] = useState("");
    const [ledgerFilters, setLedgerFilters] = useState({ month, category: "all", currency: "all", sort: "date_desc", page: 1 });
    // A shared month change starts at page one, even when this Circle is already open.
    if (ledgerFilters.month !== month) setLedgerFilters({ ...ledgerFilters, month, page: 1 });
    const range = useMemo(() => monthBounds(month, preferences.timezone), [month, preferences.timezone]);
    const refresh = useCallback(() => setRevision((value) => value + 1), []);
    useEffect(() => {
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") refresh();
        }, 20000);
        window.addEventListener("focus", refresh);
        return () => {
            clearInterval(timer);
            window.removeEventListener("focus", refresh);
        };
    }, [refresh]);
    useEffect(() => {
        let active = true;
        async function load() {
            setLoading(true);
            try {
                const [nextIndex, nextDetail] = await Promise.all([
                    circlesApi.list(),
                    selected ?
                            circlesApi.detail(selected, ledgerFilters.page, settlementPage, { expense_from: range.from, expense_to: range.to, expense_category: ledgerFilters.category, expense_currency: ledgerFilters.currency, expense_sort: ledgerFilters.sort }) :
                            Promise.resolve(null),
                ]);
                if (active) {
                    setIndex(nextIndex);
                    setData(nextDetail);
                    setError("");
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
    }, [selected, ledgerFilters, range, settlementPage, revision]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (
                data?.circle.id !== selected ||
                !data?.circle.permissions.can_add ||
                event.key.toLowerCase() !== "n" || event.metaKey || event.ctrlKey || event.altKey ||
                (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[contenteditable]")) ||
                document.querySelector("[role=\"dialog\"]")
            ) return;
            event.preventDefault();
            setEditor("new");
        };

        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [data, selected]);
    function open(id: string | null) {
        setSelected(id);
        setSettlementPage(1);
        setFilterCurrency("");
        setLedgerFilters({ month, category: "all", currency: "all", sort: "date_desc", page: 1 });
        setTab("Expenses");
    }

    const detail = data?.circle.id === selected ? data : null;
    const currencies = [
        ...new Set([
            detail?.circle.currency || preferences.currency,
            ...(detail?.totals.map((row) => row.currency) || []),
            ...(detail?.balances.map((row) => row.currency) || []),
        ]),
    ];
    const currency = currencies.includes(filterCurrency) ?
        filterCurrency :
        detail?.circle.currency || preferences.currency;
    const ownBalance =
        detail?.balances.find((row) => row.member === detail.me && row.currency === currency)
            ?.net || 0;
    const summary = detail?.totals.find((row) => row.currency === currency);
    async function copyLink(id: string) {
        try {
            await navigator.clipboard.writeText(invitationLink(id));
            toast.success("Invitation link copied");
        } catch {
            toast.error(
                "Clipboard access is unavailable. Create a new invitation to select its link.",
            );
        }
    }

    function removeExpense(expense: CircleExpense) {
        setViewing(null);
        setConfirmation({
            title: `Delete shared ${expense.kind}?`,
            description: `${expense.title} · ${money(expense.amount, expense.currency)} ${expense.currency}. Member balances will be recalculated.${expense.recurrence ? " Future recurring entries will stop; existing entries remain." : ""}`,
            label: `Delete ${expense.kind}`,
            action: async () => {
                await circlesApi.deleteExpense(selected!, expense);
                refresh();
            },
        });
    }

    function undoSettlement(payment: CircleSettlement) {
        setConfirmation({
            title: "Delete repayment?",
            description:
                "The repayment record will be removed and member balances recalculated. No money will be moved.",
            label: "Delete repayment",
            action: async () => {
                await circlesApi.undoSettlement(selected!, payment);
                refresh();
            },
        });
    }

    function removeMember(member: CircleMember) {
        setConfirmation({
            title: `Remove ${member.name}?`,
            description: "They will lose access. Their transaction history will remain.",
            label: "Remove member",
            action: async () => {
                await circlesApi.removeMember(selected!, member.id);
                refresh();
            },
        });
    }

    function revokeInvitation(invitation: CircleInvitation) {
        setConfirmation({
            title: "Revoke invitation?",
            description: invitation.email,
            label: "Revoke",
            action: async () => {
                await circlesApi.revoke(invitation.id);
                refresh();
            },
        });
    }

    async function copyCircleId() {
        if (!detail) return;
        try {
            await navigator.clipboard.writeText(detail.circle.id);
            toast.success("Circle ID copied");
        } catch {
            toast.error("Could not copy Circle ID", { description: detail.circle.id });
        }
    }

    return (
        <section className="space-y-8 animate-enter">
            <div className="flex flex-wrap items-center justify-between gap-3">
                {selected ?
                        (
                            <Button variant="ghost" onClick={() => open(null)} className="-ml-3">
                                <ArrowLeft />
                                All Circles
                            </Button>
                        ) :
                        (
                            <p className="text-xs text-muted-foreground">
                                {index?.circles.length || 0} circles
                            </p>
                        )}
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Refresh circles"
                        onClick={refresh}
                        disabled={loading}>
                        <RefreshCw className={loading ? "animate-spin" : ""} />
                    </Button>
                    {!selected && (
                        <Button onClick={() => setDialog("create")}>
                            <Plus />
                            New Circle
                        </Button>
                    )}
                </div>
            </div>
            {error && (
                <div className="rounded-lg border border-destructive/25 p-4">
                    <FormError error={error} />
                    <Button variant="outline" className="mt-3" onClick={refresh}>
                        Try again
                    </Button>
                </div>
            )}
            {loading && !index && (
                <div className="grid min-h-48 place-items-center">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
            )}
            {!selected && index && !error && (
                <>
                    {index.invitations.length > 0 && (
                        <div>
                            <h2 className="mb-2 text-sm font-medium">Invitations</h2>
                            <div className="divide-y border-y">
                                {index.invitations.map((invitation) => (
                                    <div
                                        key={invitation.id}
                                        className="flex flex-wrap items-center gap-4 py-5">
                                        <CircleIcon name={invitation.expand.circle.icon} />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm">
                                                {invitation.expand.circle.name}
                                            </p>
                                            <p className="mt-1 text-[11px] text-muted-foreground">
                                                Expires{" "}
                                                {dayLabel(
                                                    invitation.expires_at,
                                                    preferences.timezone,
                                                )}
                                            </p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            onClick={() =>
                                                setConfirmation({
                                                    title: "Decline invitation?",
                                                    description: invitation.expand.circle.name,
                                                    label: "Decline",
                                                    action: async () => {
                                                        await circlesApi.revoke(invitation.id);
                                                        refresh();
                                                    },
                                                })}>
                                            Decline
                                        </Button>
                                        <Button
                                            onClick={() =>
                                                void circlesApi
                                                    .accept(invitation.id)
                                                    .then((result) => {
                                                        open(result.circle);
                                                        refresh();
                                                    })
                                                    .catch((e) => toast.error(errorMessage(e)))}>
                                            Join circle
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="divide-y border-t">
                        {index.circles.map((circle) => (
                            <button
                                key={circle.id}
                                onClick={() => open(circle.id)}
                                className="group flex w-full items-center gap-4 py-6 text-left transition-colors hover:bg-white/2">
                                <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-primary/4 text-primary">
                                    <CircleIcon name={circle.icon} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate font-display text-xl font-semibold tracking-[-0.4px]">
                                        {circle.name}
                                    </span>
                                    <span className="mt-1 block text-[11px] text-muted-foreground">
                                        {circle.member_count}{" "}
                                        {circle.member_count === 1 ? "member" : "members"} ·{" "}
                                        {circle.currency}
                                        {circle.is_owner ? " · Owner" : circle.can_manage ? " · Admin" : ""}
                                    </span>
                                </span>
                                <ArrowRight className="mr-2 size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
                            </button>
                        ))}
                    </div>
                    {!index.circles.length && (
                        <div className="py-12 text-center">
                            <CircleIcon
                                name="users"
                                className="mx-auto mb-4 size-8 text-primary/60"
                            />
                            <h2 className="font-display text-xl font-semibold tracking-[-0.4px]">No Circles</h2>
                            <p className="mt-3 text-xs text-muted-foreground">
                                Create a Circle to share expenses and income.
                            </p>
                        </div>
                    )}
                </>
            )}
            {selected && !detail && !error && (
                <div className="grid min-h-48 place-items-center">
                    <Loader2 className="size-5 animate-spin" />
                </div>
            )}
            {detail && !error && (
                <>
                    <div className="flex flex-wrap items-start justify-between gap-5">
                        <div className="flex min-w-0 basis-full items-center gap-4 sm:flex-1 sm:basis-auto">
                            <span className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-primary/4 text-primary">
                                <CircleIcon name={detail.circle.icon} />
                            </span>
                            <div className="min-w-0">
                                <h2 className="font-display text-[28px] font-semibold tracking-[-0.7px] break-words sm:text-[34px]">
                                    {detail.circle.name}
                                </h2>
                                <p className="mt-2 text-[11px] text-muted-foreground">
                                    {detail.circle.member_count} {detail.circle.member_count === 1 ? "member" : "members"}
                                    {detail.circle.is_owner ? " · Owner" : detail.circle.can_manage ? " · Admin" : ""}
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {detail.circle.permissions.can_add && (
                                <>
                                    <Button variant="outline" onClick={() => setEditor("income")}><Plus /> Add income</Button>
                                    <Button onClick={() => setEditor("new")}>
                                        <Plus />
                                        Add expense
                                    </Button>
                                </>
                            )}
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        aria-label="Circle actions">
                                        <Ellipsis />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-max max-w-(--radix-dropdown-menu-content-available-width) whitespace-nowrap">
                                    <DropdownMenuItem onClick={() => setDialog("members")}>Members</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => void copyCircleId()}>
                                        <Copy /> Copy Circle ID
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {detail.circle.can_manage && (
                                        <>
                                            <DropdownMenuItem onClick={() => setDialog("settings")}>
                                                Circle settings
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => setDialog("categories")}>Categories</DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => setDialog("invite")}>
                                                Invite member
                                            </DropdownMenuItem>
                                        </>
                                    )}
                                    {detail.circle.is_owner ?
                                            (
                                                <>
                                                    <DropdownMenuItem onClick={() => setDialog("transfer")}>
                                                        Transfer ownership
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        variant="destructive"
                                                        onClick={() =>
                                                            setConfirmation({
                                                                title: "Delete Circle?",
                                                                description:
                                                            "This permanently deletes the Circle, shared transactions, invitations, repayments, and balances for every member. This cannot be undone.",
                                                                label: "Delete Circle",
                                                                confirmationName: detail.circle.name,
                                                                action: async (confirmation) => {
                                                                    await circlesApi.remove(
                                                                        detail.circle,
                                                                        confirmation,
                                                                    );
                                                                    open(null);
                                                                    refresh();
                                                                },
                                                            })}>
                                                        Delete Circle
                                                    </DropdownMenuItem>
                                                </>
                                            ) :
                                            (
                                                <DropdownMenuItem
                                                    variant="destructive"
                                                    disabled={detail.balances.some(
                                                        (row) => row.member === detail.me && row.net !== 0,
                                                    )}
                                                    onClick={() =>
                                                        setConfirmation({
                                                            title: "Leave Circle?",
                                                            description:
                                                        "You will lose access. Your transaction history will remain.",
                                                            label: "Leave Circle",
                                                            action: async () => {
                                                                await circlesApi.removeMember(
                                                                    detail.circle.id,
                                                                    detail.me,
                                                                );
                                                                open(null);
                                                                refresh();
                                                            },
                                                        })}>
                                                    Leave Circle
                                                </DropdownMenuItem>
                                            )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-4">
                        <div className="flex gap-5 border-b">
                            {(["Expenses", "Balances"] as const).map((item) => (
                                <button
                                    key={item}
                                    onClick={() => setTab(item)}
                                    aria-pressed={tab === item}
                                    className={`border-b-2 py-3 text-xs transition-colors ${tab === item ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                                    {item === "Expenses" ? "Transactions" : item}
                                </button>
                            ))}
                        </div>
                        <div className="max-w-64">
                            <label className="sr-only" htmlFor="circle-view-currency">
                                Balance currency
                            </label>
                            <CurrencySelect
                                id="circle-view-currency"
                                value={currency}
                                onChange={setFilterCurrency}
                                codes={currencies}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-6 border-b pb-7 sm:gap-12">
                        <div>
                            <p className="eyebrow text-[9px]">Total spent · All time · {currency}</p>
                            <p className="mt-3 text-[clamp(28px,4vw,48px)] tracking-[-1px] break-words tabular-nums">
                                {money(summary?.total || 0, currency)}
                            </p>
                            <p className="mt-2 text-[10px] text-muted-foreground">
                                {summary?.count || 0} {summary?.count === 1 ? "expense" : "expenses"} in {currency}
                            </p>
                            <p className="mt-2 text-[10px] text-primary">Income {money(summary?.income || 0, currency)}
                            </p>
                        </div>
                        <div>
                            <p className="eyebrow text-[9px]">
                                {ownBalance > 0 ?
                                    "You are owed" :
                                    ownBalance < 0 ?
                                        "You owe" :
                                        "Your balance"}{" "}
                                · {currency}
                            </p>
                            <p
                                className={`mt-3 text-[clamp(28px,4vw,48px)] tracking-[-1px] break-words tabular-nums ${ownBalance < 0 ? "text-destructive" : "text-primary"}`}>
                                {money(Math.abs(ownBalance), currency)}
                            </p>
                            <p className="mt-2 text-[10px] text-muted-foreground">
                                Balances stay separate by currency.
                            </p>
                        </div>
                    </div>
                    {tab === "Expenses" && detail.recurring.length > 0 && (
                        <div className="space-y-3 border-b pb-5">
                            <h3 className="text-xs font-medium">Recurring transactions</h3>
                            {detail.recurring.map((item) => (
                                <button key={item.id} className="block w-full text-left text-xs text-muted-foreground" onClick={() => setViewing(item)}>
                                    {item.title} · {item.kind === "income" ? "Income" : "Expense"} · {recurrenceLabel(item)} · {item.recurrence_error ? `Paused: ${item.recurrence_error}` : `Next ${dateTimeLabel(item.recurrence_next, item.recurrence_timezone, preferences.time_format)}`}
                                </button>
                            ))}
                        </div>
                    )}
                    {tab === "Expenses" && (
                        <div className="flex flex-wrap items-center gap-3" aria-label="Circle transaction filters">
                            <MonthPicker value={month} onChange={onMonthChange} timezone={preferences.timezone} />
                            <Select value={ledgerFilters.category} onValueChange={(category) => setLedgerFilters({ ...ledgerFilters, category, page: 1 })}>
                                <SelectTrigger aria-label="Circle category" className="h-10! w-auto min-w-36 max-w-full text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All categories</SelectItem>
                                    {detail.categories.map((category) => <SelectItem key={category.id} value={category.id}><CategoryIcon category={category.name} color={category.color} small />{category.name}{!category.active && " (archived)"}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            <Select value={ledgerFilters.currency} onValueChange={(currency) => setLedgerFilters({ ...ledgerFilters, currency, page: 1 })}>
                                <SelectTrigger aria-label="Circle transaction currency" className="h-10! w-auto text-xs"><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem value="all">All currencies</SelectItem>{currencies.map((code) => <SelectItem key={code} value={code}>{code}</SelectItem>)}</SelectContent>
                            </Select>
                            <TransactionSort value={ledgerFilters.sort} onChange={(sort) => setLedgerFilters({ ...ledgerFilters, sort, page: 1 })} />
                            {(ledgerFilters.category !== "all" || ledgerFilters.currency !== "all" || ledgerFilters.sort !== "date_desc") && <Button variant="ghost" size="sm" onClick={() => setLedgerFilters({ month, category: "all", currency: "all", sort: "date_desc", page: 1 })}>Reset filters</Button>}
                        </div>
                    )}
                    {tab === "Expenses" && ledgerFilters.sort.startsWith("amount_") && ledgerFilters.currency === "all" && <p className="text-xs text-muted-foreground">Amounts in original currencies</p>}
                    {tab === "Expenses" && (
                        <CircleExpenseList
                            detail={detail}
                            onView={setViewing}
                            onPage={(page) => setLedgerFilters({ ...ledgerFilters, page })}
                            filtered
                        />
                    )}
                    {tab === "Balances" && (
                        <CircleBalances
                            detail={detail}
                            currency={currency}
                            onSettle={setSettlement}
                            onEdit={setSettlement}
                            onUndo={undoSettlement}
                            onPage={setSettlementPage}
                        />
                    )}
                    {dialog === "members" && (
                        <Dialog open onOpenChange={(open) => { if (!open) setDialog(null); }}>
                            <DialogContent className="sm:max-w-2xl">
                                <DialogHeader><DialogTitle>Members</DialogTitle><DialogDescription>{detail.circle.name}</DialogDescription></DialogHeader>
                                <CircleMembers
                                    detail={detail}
                                    onInvite={() => setDialog("invite")}
                                    onCopy={copyLink}
                                    onRemove={removeMember}
                                    onRevoke={revokeInvitation}
                                    onPermissions={setPermissionMember}
                                />
                            </DialogContent>
                        </Dialog>
                    )}
                </>
            )}
            {dialog === "create" && (
                <CircleSettingsDialog
                    circle={null}
                    currency={preferences.currency}
                    onClose={() => setDialog(null)}
                    onSaved={(id) => {
                        open(id);
                        refresh();
                    }}
                />
            )}
            {detail && dialog === "categories" && <CircleCategorySettings data={detail} onClose={() => setDialog(null)} onSaved={refresh} />}
            {detail && permissionMember && <CirclePermissionsDialog key={permissionMember.id} circle={detail.circle.id} member={permissionMember} onClose={() => setPermissionMember(null)} onSaved={refresh} />}
            {detail && dialog === "settings" && (
                <CircleSettingsDialog
                    circle={detail.circle}
                    currency={detail.circle.currency}
                    onClose={() => setDialog(null)}
                    onSaved={refresh}
                />
            )}
            {detail && dialog === "invite" && (
                <InviteDialog
                    circle={detail.circle}
                    onClose={() => setDialog(null)}
                    onSaved={refresh}
                />
            )}
            {detail && dialog === "transfer" && (
                <TransferDialog data={detail} onClose={() => setDialog(null)} onSaved={refresh} />
            )}
            {detail && editor && (
                <CircleExpenseEditor
                    data={detail}
                    expense={typeof editor === "string" ? null : editor}
                    kind={editor === "income" ? "income" : "expense"}
                    onClose={() => setEditor(null)}
                    onSaved={() => {
                        refresh();
                        toast.success("Shared entry saved");
                    }}
                />
            )}
            {detail && settlement && (
                <SettlementDialog
                    data={detail}
                    suggestion={settlement}
                    settlement={"id" in settlement ? settlement : undefined}
                    onClose={() => setSettlement(null)}
                    onSaved={() => {
                        refresh();
                        toast.success("id" in settlement ? "Repayment updated" : "Settlement recorded");
                    }}
                />
            )}
            {confirmation && (
                <CircleConfirmDialog
                    title={confirmation.title}
                    description={confirmation.description}
                    label={confirmation.label}
                    confirmationName={confirmation.confirmationName}
                    onClose={() => setConfirmation(null)}
                    onConfirm={confirmation.action}
                />
            )}
            {detail && viewing && (
                <CircleExpenseDetails
                    expense={viewing}
                    detail={detail}
                    onClose={() => setViewing(null)}
                    onMove={canMoveCircleExpense(detail, viewing) ?
                            () => {
                                setMoving(viewing);
                                setViewing(null);
                            } :
                        undefined}
                    onDelete={canModifyCircleExpense(detail, viewing, "delete") ? () => removeExpense(viewing) : undefined}
                    onEdit={canModifyCircleExpense(detail, viewing, "edit") ?
                            () => {
                                setEditor(viewing);
                                setViewing(null);
                            } :
                        undefined}
                />
            )}
            {detail && moving && (
                <MoveToPersonalDialog
                    circle={detail.circle.id}
                    expense={moving}
                    onClose={() => setMoving(null)}
                    onRefresh={() => {
                        refresh();
                        onTransactionMoved();
                    }}
                    onMoved={() => {
                        refresh();
                        onTransactionMoved();
                        toast.success(`${moving.kind === "income" ? "Income" : "Expense"} moved to personal`);
                    }}
                />
            )}
        </section>
    );
}
