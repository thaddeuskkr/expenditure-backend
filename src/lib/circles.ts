import receiptCore from "../../pocketbase/pb_hooks/receipt-core.cjs";
import core from "../../pocketbase/pb_hooks/circles-core.cjs";
import type { Expense, CategoryDefinition, RecurringFields, RecurrenceSchedule } from "./domain";
import { pb } from "./pocketbase";

export { core as circleCore, receiptCore };
export type CircleReceipt = receiptCore.Receipt;
export type ReceiptResult = receiptCore.Result;
export const SPLIT_LABELS = { even: "Equal", percentage: "Percentage", exact: "Exact amounts" };
export type SplitMode = core.SplitMode;
export type CircleIconName = core.CircleIcon;
export type CircleShare = core.Share;
export type CircleBalance = core.Balance;
export type SettlementSuggestion = core.SettlementSuggestion;
export type CirclePermissionScope = "none" | "own" | "all";
export type CircleMoveScope = "none" | "payer" | "all";
export interface CirclePermissions {
    can_add: boolean;
    edit_scope: CirclePermissionScope;
    delete_scope: CirclePermissionScope;
    move_scope: CircleMoveScope;
}
export interface Circle {
    id: string;
    name: string;
    icon: CircleIconName;
    currency: string;
    owner: string;
    is_owner: boolean;
    can_manage: boolean;
    member_count: number;
    version: number;
    permissions: CirclePermissions;
}
export interface CircleMemberPermissions extends CirclePermissions {
    is_admin: boolean;
}
export interface CircleMember extends CircleMemberPermissions {
    id: string;
    name: string;
    active: boolean;
    user: string;
    version: number;
    expand: { user?: { id: string; collectionId: string; name: string; avatar: string } };
}
export interface CircleExpense extends RecurringFields {
    kind: "expense" | "income";
    id: string;
    title: string;
    category: string;
    expand?: { category?: CategoryDefinition };
    source: "manual" | "api" | "shortcut";
    origin_expense: string;
    currency: string;
    amount: number;
    paid_by: string;
    created_by: string;
    receipt: CircleReceipt | null;
    split_mode: SplitMode;
    shares: CircleShare[];
    payment_method: string;
    notes: string;
    occurred_at: string;
    version: number;
}
export interface CircleSettlement extends SettlementSuggestion {
    id: string;
    notes: string;
    occurred_at: string;
    created_by: string;
    version: number;
}
export interface CircleInvitation {
    id: string;
    email: string;
    expires_at: string;
}
export interface IncomingInvitation extends CircleInvitation {
    circle: string;
    expand: { circle: Pick<Circle, "id" | "name" | "icon" | "currency"> };
}
export interface CirclePage<T> {
    items: T[];
    page: number;
    totalItems: number;
    totalPages: number;
}
export interface CircleDetail {
    circle: Circle;
    me: string;
    members: CircleMember[];
    balances: CircleBalance[];
    suggestions: SettlementSuggestion[];
    totals: { currency: string; total: number; income: number; count: number }[];
    recurring: CircleExpense[];
    expenses: CirclePage<CircleExpense>;
    settlements: CirclePage<CircleSettlement>;
    invitations: CircleInvitation[];
    categories: CategoryDefinition[];
}
export interface CircleIndex {
    circles: Circle[];
    invitations: IncomingInvitation[];
}
export interface CircleExpenseInput extends RecurrenceSchedule {
    category: string;
    kind: "expense" | "income";
    title: string;
    currency: string;
    amount: number;
    paid_by: string;
    receipt?: CircleReceipt | null;
    split_mode: SplitMode;
    shares: core.SplitInput[];
    payment_method: string;
    notes: string;
    occurred_at: string;
    version?: number;
}
const base = "/api/expenditure/circles";
const invitations = "/api/expenditure/circle-invitations";
export const circlesApi = {
    list: () => pb.send<CircleIndex>(base, { method: "GET" }),
    detail: (id: string, expensePage = 1, settlementPage = 1, filters: { expense_from?: string; expense_to?: string; expense_category?: string; expense_currency?: string; expense_sort?: string } = {}) =>
        pb.send<CircleDetail>(
            `${base}/${id}?${new URLSearchParams({ expense_page: String(expensePage), settlement_page: String(settlementPage), ...filters })}`,
            { method: "GET" },
        ),
    create: (data: Pick<Circle, "name" | "icon" | "currency">) =>
        pb.send<Circle>(base, { method: "POST", body: data }),
    update: (
        id: string,
        data: Partial<Pick<Circle, "name" | "icon" | "currency">> & {
            version: number;
            owner?: string;
        },
    ) => pb.send<Circle>(`${base}/${id}`, { method: "PATCH", body: data }),
    remove: (circle: Circle, confirmation: string) =>
        pb.send(`${base}/${circle.id}`, {
            method: "DELETE",
            body: { confirmation, version: circle.version },
        }),
    invite: (id: string, email: string) =>
        pb.send<CircleInvitation>(`${base}/${id}/invitations`, { method: "POST", body: { email } }),
    previewInvitation: (id: string) =>
        pb.send<IncomingInvitation>(`${invitations}/${encodeURIComponent(id)}`, { method: "GET" }),
    accept: (id: string) =>
        pb.send<{ circle: string }>(`${invitations}/${encodeURIComponent(id)}/accept`, {
            method: "POST",
        }),
    revoke: (id: string) => pb.send(`${invitations}/${id}`, { method: "DELETE" }),
    removeMember: (circle: string, member: string) =>
        pb.send(`${base}/${circle}/members/${member}`, { method: "DELETE" }),
    updateMemberPermissions: (circle: string, member: CircleMember, data: CircleMemberPermissions) =>
        pb.send<CircleMember>(`${base}/${circle}/members/${member.id}/permissions`, {
            method: "PATCH", body: { ...data, version: member.version },
        }),
    moveExpense: (circle: string, expense: Expense, category: string) =>
        pb.send<CircleExpense>(`${base}/${circle}/expenses/move`, {
            method: "POST", body: { expense: expense.id, previous_updated: expense.updated, category },
        }),
    moveToPersonal: (circle: string, expense: CircleExpense, category: string) =>
        pb.send<Expense>(`${base}/${circle}/expenses/${expense.id}/move-to-personal`, {
            method: "POST", body: { version: expense.version, category },
        }),
    copyCategories: (circle: string, previous_ids: string[]) =>
        pb.send<{ items: CategoryDefinition[] }>(`${base}/${circle}/categories/copy`, { method: "POST", body: { previous_ids } }),
    saveExpense: (circle: string, data: CircleExpenseInput, id?: string) =>
        pb.send<CircleExpense>(`${base}/${circle}/expenses${id ? "/" + id : ""}`, {
            method: id ? "PATCH" : "POST",
            body: data,
        }),
    deleteExpense: (circle: string, expense: CircleExpense) =>
        pb.send(`${base}/${circle}/expenses/${expense.id}`, {
            method: "DELETE",
            body: { version: expense.version },
        }),
    settle: (circle: string, data: SettlementSuggestion & { notes: string; occurred_at: string }, settlement?: CircleSettlement) =>
        pb.send<CircleSettlement>(`${base}/${circle}/settlements${settlement ? "/" + settlement.id : ""}`, {
            method: settlement ? "PATCH" : "POST",
            body: { ...data, ...(settlement ? { version: settlement.version } : {}) },
        }),
    undoSettlement: (circle: string, settlement: CircleSettlement) =>
        pb.send(`${base}/${circle}/settlements/${settlement.id}`, {
            method: "DELETE",
            body: { version: settlement.version },
        }),
};

export function canModifyCircleExpense(detail: CircleDetail, expense: CircleExpense, action: "edit" | "delete") {
    const scope = detail.circle.permissions[`${action}_scope`];
    return scope === "all" || (scope === "own" && expense.created_by === detail.me);
}

export function canMoveCircleExpense(detail: CircleDetail, expense: CircleExpense) {
    const scope = detail.circle.permissions.move_scope;
    return scope === "all" || (scope === "payer" && expense.paid_by === detail.me);
}

export function invitationLink(id: string) {
    return `${window.location.origin}/?circle_invite=${encodeURIComponent(id)}`;
}

export function clearInvitationLink() {
    const url = new URL(window.location.href);
    url.searchParams.delete("circle_invite");
    window.history.replaceState(window.history.state, "", url);
}
