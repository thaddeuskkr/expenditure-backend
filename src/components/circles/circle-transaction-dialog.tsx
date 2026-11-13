"use client";

import { ArrowUpRight, CalendarDays, Code2, CreditCard } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { CategoryIcon } from "../category-icon";
import { useWorkspace } from "../workspace-context";
import { categoryLabel, dateTimeLabel, money, recurrenceLabel, type CircleTransaction } from "@/lib/domain";

export function CircleTransactionDialog({ transaction, onClose, onOpenCircle }: {
    transaction: CircleTransaction;
    onClose: () => void;
    onOpenCircle: (circle: string) => void;
}) {
    const { preferences } = useWorkspace();
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="gap-5 p-5 sm:max-w-lg sm:p-6">
                <DialogHeader className="gap-4">
                    <div className="flex items-start gap-3 pr-6">
                        <CategoryIcon category={categoryLabel(transaction)} />
                        <div className="min-w-0">
                            <DialogTitle className="font-display text-2xl leading-tight font-semibold tracking-[-0.5px] wrap-anywhere">{transaction.title}</DialogTitle>
                            <DialogDescription className="mt-1 text-[11px] wrap-anywhere">{transaction.expand.circle.name}</DialogDescription>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
                        <div className="min-w-0">
                            <p className="mb-1 text-[10px] text-muted-foreground">Your share</p>
                            <p className={`flex flex-wrap items-baseline gap-x-2 text-[32px] leading-tight tracking-[-1px] tabular-nums ${transaction.kind === "income" ? "text-primary" : ""}`}>
                                <span className="wrap-anywhere">{money(transaction.allocated_amount, transaction.currency)}</span>
                                <span className="text-xs tracking-normal text-muted-foreground">{transaction.currency}</span>
                            </p>
                        </div>
                        <div className="min-w-0 pb-0.5">
                            <p className="text-[10px] text-muted-foreground">Total {transaction.kind}</p>
                            <p className="mt-1 text-xs wrap-anywhere tabular-nums">{money(transaction.amount, transaction.currency)} <span className="text-[10px] text-muted-foreground">{transaction.currency}</span></p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="rounded-md border px-2 py-1 wrap-anywhere">{categoryLabel(transaction)}</span>
                        {transaction.recurrence && <span className="rounded-md bg-white/4 px-2 py-1 wrap-anywhere">{recurrenceLabel(transaction)}</span>}
                        {transaction.source === "api" && <span className="flex items-center gap-1.5 px-1 py-1"><Code2 aria-hidden="true" className="size-3" />Via API</span>}
                        {transaction.source === "shortcut" && <span className="flex items-center gap-1.5 px-1 py-1"><Code2 aria-hidden="true" className="size-3" />Via Shortcut</span>}
                    </div>
                </DialogHeader>
                <dl className="grid gap-4 border-y py-4 sm:grid-cols-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                        <CalendarDays aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                            <dt className="text-[10px] text-muted-foreground">Date & time</dt>
                            <dd className="mt-1 text-xs">
                                <span className="block wrap-anywhere">{dateTimeLabel(transaction.occurred_at, preferences.timezone, preferences.time_format)}</span>
                                <span className="mt-1 block text-[10px] text-muted-foreground wrap-anywhere">{preferences.timezone.replaceAll("_", " ")}</span>
                            </dd>
                        </div>
                    </div>
                    {transaction.payment_method && (
                        <div className="flex min-w-0 items-start gap-2.5">
                            <CreditCard aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                                <dt className="text-[10px] text-muted-foreground">Payment method</dt>
                                <dd className="mt-1 text-xs wrap-anywhere">{transaction.payment_method}</dd>
                            </div>
                        </div>
                    )}
                    {categoryLabel(transaction) !== transaction.budget_category_name && (
                        <div className="min-w-0 sm:col-span-2">
                            <dt className="text-[10px] text-muted-foreground">Personal category</dt>
                            <dd className="mt-1 text-xs wrap-anywhere">{transaction.budget_category_name}</dd>
                        </div>
                    )}
                </dl>
                {transaction.notes && <section><h3 className="mb-2 text-[10px] text-muted-foreground">Notes</h3><p className="text-xs leading-6 wrap-anywhere whitespace-pre-wrap">{transaction.notes}</p></section>}
                {transaction.membership_active && (
                    <div className={`flex flex-col gap-2 sm:flex-row sm:justify-end ${transaction.notes ? "border-t pt-4" : ""}`}>
                        <Button className="h-10 px-5" onClick={() => onOpenCircle(transaction.circle)}>Open Circle<ArrowUpRight aria-hidden="true" /></Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
