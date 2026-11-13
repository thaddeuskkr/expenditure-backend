"use client";

import { ArrowUpRight, CalendarDays, Code2, CreditCard, Pencil, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { CategoryIcon } from "../category-icon";
import { UserAvatar } from "../user-avatar";
import { useWorkspace } from "../workspace-context";
import { categoryLabel, dateTimeLabel, money, recurrenceLabel } from "@/lib/domain";
import { ReceiptSummary } from "./receipt-editor";
import { receiptCore, SPLIT_LABELS, type CircleDetail, type CircleExpense, type CircleMember } from "@/lib/circles";

function MemberAvatar({ member, name }: { member?: CircleMember; name: string }) {
    if (member?.expand.user) return <UserAvatar user={member.expand.user} name={name} />;
    return <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] text-primary">{name.slice(0, 2).toUpperCase()}</span>;
}

export function CircleExpenseDetails({ expense, detail, onClose, onEdit, onDelete, onMove }: {
    expense: CircleExpense;
    detail: CircleDetail;
    onClose: () => void;
    onEdit?: () => void;
    onDelete?: () => void;
    onMove?: () => void;
}) {
    const { preferences } = useWorkspace();
    const payer = detail.members.find((member) => member.id === expense.paid_by);
    const payerName = payer?.name || "Former member";
    const myShare = expense.shares.find((share) => share.member === detail.me)?.amount || 0;
    const receiptResult = expense.receipt ? receiptCore.calculate(expense.receipt) : null;
    const splitLabel = expense.receipt ? "Receipt split" : `${SPLIT_LABELS[expense.split_mode]}${expense.split_mode === "exact" ? "" : " split"}`;
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="gap-5 p-5 sm:max-w-lg sm:p-6">
                <DialogHeader className="gap-4">
                    <div className="flex items-start gap-3 pr-6">
                        <CategoryIcon category={categoryLabel(expense)} color={detail.categories.find((category) => category.id === expense.category)?.color} />
                        <div className="min-w-0">
                            <DialogTitle className="font-display text-2xl leading-tight font-semibold tracking-[-0.5px] wrap-anywhere">{expense.title}</DialogTitle>
                            <DialogDescription className="mt-1 text-[11px] wrap-anywhere">{detail.circle.name}</DialogDescription>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                        <div className="min-w-0">
                            <p className="mb-1 text-[10px] text-muted-foreground">Total {expense.kind}</p>
                            <p className={`flex flex-wrap items-baseline gap-x-2 text-[32px] leading-tight tracking-[-1px] tabular-nums ${expense.kind === "income" ? "text-primary" : ""}`}>
                                <span className="wrap-anywhere">{money(expense.amount, expense.currency)}</span>
                                <span className="text-xs tracking-normal text-muted-foreground">{expense.currency}</span>
                            </p>
                        </div>
                        <div className="flex min-w-0 items-center gap-2.5 pb-0.5">
                            <MemberAvatar member={payer} name={payerName} />
                            <div className="min-w-0">
                                <p className="text-[10px] text-muted-foreground">{expense.kind === "income" ? "Received by" : "Paid by"}</p>
                                <p className="mt-0.5 text-xs wrap-anywhere">{payerName}{expense.paid_by === detail.me ? " (you)" : ""}</p>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="rounded-md border px-2 py-1 wrap-anywhere">{categoryLabel(expense)}</span>
                        <span className="rounded-md bg-white/4 px-2 py-1">{splitLabel}</span>
                        {expense.recurrence && <span className="rounded-md bg-white/4 px-2 py-1 wrap-anywhere">{recurrenceLabel(expense)}</span>}
                        {expense.source === "api" && <span className="flex items-center gap-1.5 px-1 py-1"><Code2 aria-hidden="true" className="size-3" />Via API</span>}
                        {expense.source === "shortcut" && <span className="flex items-center gap-1.5 px-1 py-1"><Code2 aria-hidden="true" className="size-3" />Via Shortcut</span>}
                    </div>
                </DialogHeader>
                <dl className="grid gap-4 border-y py-4 sm:grid-cols-2">
                    <div className="min-w-0">
                        <dt className="text-[10px] text-muted-foreground">Your share</dt>
                        <dd className="mt-1 text-sm tabular-nums wrap-anywhere">{money(myShare, expense.currency)} <span className="text-[10px] text-muted-foreground">{expense.currency}</span></dd>
                    </div>
                    <div className="flex min-w-0 items-start gap-2.5">
                        <CalendarDays aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                            <dt className="text-[10px] text-muted-foreground">Date & time</dt>
                            <dd className="mt-1 text-xs">
                                <span className="block wrap-anywhere">{dateTimeLabel(expense.occurred_at, preferences.timezone, preferences.time_format)}</span>
                                <span className="mt-1 block text-[10px] text-muted-foreground wrap-anywhere">{preferences.timezone.replaceAll("_", " ")}</span>
                            </dd>
                        </div>
                    </div>
                    {expense.payment_method && (
                        <div className="flex min-w-0 items-start gap-2.5">
                            <CreditCard aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                                <dt className="text-[10px] text-muted-foreground">Payment method</dt>
                                <dd className="mt-1 text-xs wrap-anywhere">{expense.payment_method}</dd>
                            </div>
                        </div>
                    )}
                </dl>
                {expense.receipt && receiptResult && (
                    <section aria-label="Receipt breakdown" className="space-y-4">
                        <div className="divide-y border-t">{expense.receipt.items.map((item, index) => <div key={index} className="flex items-start justify-between gap-3 py-3"><div className="min-w-0"><p className="text-xs wrap-anywhere">{item.label}</p><p className="mt-1 text-[10px] text-muted-foreground wrap-anywhere">{item.members.map((id) => detail.members.find((member) => member.id === id)?.name || "Former member").join(", ")}</p></div><span className="shrink-0 text-xs tabular-nums">{money(item.amount, expense.currency)}</span></div>)}</div>
                        <ReceiptSummary result={receiptResult} currency={expense.currency} receipt={expense.receipt} />
                    </section>
                )}
                <section aria-label="Split breakdown">
                    <div className="mb-2 flex items-center justify-between gap-3">
                        <h3 className="text-xs font-medium">Split breakdown</h3>
                        <span className="text-[10px] text-muted-foreground">{expense.shares.length} {expense.shares.length === 1 ? "member" : "members"}</span>
                    </div>
                    <ul className="divide-y">
                        {expense.shares.map((share) => {
                            const member = detail.members.find((item) => item.id === share.member);
                            const name = member?.name || "Former member";
                            return (
                                <li key={share.member} className="flex items-center gap-3 py-3">
                                    <MemberAvatar member={member} name={name} />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs wrap-anywhere">{name}{share.member === detail.me ? <span className="text-muted-foreground"> (you)</span> : ""}</p>
                                        {receiptResult && (() => {
                                            const row = receiptResult.rows.find((row) => row.member === share.member);
                                            return row && <p className="mt-1 text-[10px] leading-5 text-muted-foreground">Items {money(row.items, expense.currency)}{row.discount ? ` − ${money(row.discount, expense.currency)} discount` : ""}{row.service ? ` + ${money(row.service, expense.currency)} service` : ""}{row.gst ? ` + ${money(row.gst, expense.currency)} GST` : ""}{row.adjustment ? ` ${row.adjustment < 0 ? "−" : "+"} ${money(Math.abs(row.adjustment), expense.currency)} adjustment` : ""}</p>;
                                        })()}
                                        {(share.percentage_bp !== undefined || !member?.active) && <p className="mt-1 text-[10px] text-muted-foreground">{share.percentage_bp !== undefined ? `${(share.percentage_bp / 100).toFixed(2).replace(/\.00$/, "")}%` : ""}{!member?.active ? `${share.percentage_bp !== undefined ? " · " : ""}Former member` : ""}</p>}
                                    </div>
                                    <p className="shrink-0 text-xs whitespace-nowrap tabular-nums">{money(share.amount, expense.currency)} <span className="text-[10px] text-muted-foreground">{expense.currency}</span></p>
                                </li>
                            );
                        })}
                    </ul>
                </section>
                {expense.notes && <section className="border-t pt-4"><h3 className="mb-2 text-[10px] text-muted-foreground">Notes</h3><p className="text-xs leading-6 wrap-anywhere whitespace-pre-wrap">{expense.notes}</p></section>}
                {(onEdit || onDelete || onMove) && (
                    <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:justify-between">
                        {onDelete && <Button variant="ghost" className="h-10 text-destructive sm:px-3 sm:text-xs" onClick={onDelete}><Trash2 />Delete {expense.kind}</Button>}
                        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
                            {onMove && <Button variant="outline" className="h-10 sm:px-3 sm:text-xs" onClick={onMove}><ArrowUpRight />Move to personal</Button>}
                            {onEdit && <Button className="h-10 px-5 sm:px-3 sm:text-xs" onClick={onEdit}><Pencil />Edit {expense.kind}</Button>}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
