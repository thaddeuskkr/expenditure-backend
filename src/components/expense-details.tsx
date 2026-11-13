"use client";

import { CalendarDays, Code2, CreditCard, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { CategoryIcon } from "./category-icon";
import { useWorkspace } from "./workspace-context";
import { categoryLabel, dateTimeLabel, money, recurrenceLabel, type Expense } from "@/lib/domain";

export function ExpenseDetails({ expense, onClose, onEdit, onDelete }: {
    expense: Expense;
    onClose: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    const { preferences } = useWorkspace();
    return (
        <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent className="gap-5 p-5 sm:max-w-lg sm:p-6">
                <DialogHeader className="gap-4">
                    <div className="flex items-start gap-3 pr-6">
                        <CategoryIcon category={categoryLabel(expense)} />
                        <div className="min-w-0">
                            <DialogTitle className="font-display text-2xl leading-tight font-semibold tracking-[-0.5px] wrap-anywhere">{expense.merchant}</DialogTitle>
                            <DialogDescription className="mt-1 text-[11px]">{expense.kind === "income" ? "Income details" : "Expense details"}</DialogDescription>
                        </div>
                    </div>
                    <div className="min-w-0">
                        <p className="mb-1 text-[10px] text-muted-foreground">Total {expense.kind}</p>
                        <p className={`flex flex-wrap items-baseline gap-x-2 text-[32px] leading-tight tracking-[-1px] tabular-nums ${expense.kind === "income" ? "text-primary" : ""}`}>
                            <span className="wrap-anywhere">{money(expense.amount, expense.currency)}</span>
                            <span className="text-xs tracking-normal text-muted-foreground">{expense.currency}</span>
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="rounded-md border px-2 py-1 wrap-anywhere">{categoryLabel(expense)}</span>
                        {expense.source === "api" && <span className="flex items-center gap-1.5 px-1 py-1"><Code2 aria-hidden="true" className="size-3" />Via API</span>}
                        {expense.source === "shortcut" && <span className="flex items-center gap-1.5 px-1 py-1"><Code2 aria-hidden="true" className="size-3" />Via Shortcut</span>}
                    </div>
                </DialogHeader>
                <dl className="grid gap-4 border-y py-4 sm:grid-cols-2">
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
                    {expense.recurrence && (
                        <div className="flex min-w-0 items-start gap-2.5 sm:col-span-2">
                            <RefreshCw aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                                <dt className="text-[10px] text-muted-foreground">Repeat</dt>
                                <dd className="mt-1 text-xs wrap-anywhere">
                                    {recurrenceLabel(expense)}
                                    {expense.recurrence_next && <span className="mt-1 block text-[10px] text-muted-foreground">Next {dateTimeLabel(expense.recurrence_next, expense.recurrence_timezone, preferences.time_format)} · {expense.recurrence_timezone.replaceAll("_", " ")}</span>}
                                    {expense.recurrence_error && <span className="mt-1 block text-destructive">Paused: {expense.recurrence_error}</span>}
                                </dd>
                            </div>
                        </div>
                    )}
                </dl>
                {expense.notes && <section><h3 className="mb-2 text-[10px] text-muted-foreground">Notes</h3><p className="text-xs leading-6 wrap-anywhere whitespace-pre-wrap">{expense.notes}</p></section>}
                <div className={`flex flex-col-reverse gap-2 sm:flex-row sm:justify-between ${expense.notes ? "border-t pt-4" : ""}`}>
                    <Button variant="ghost" className="h-10 text-destructive" onClick={onDelete}><Trash2 />Delete {expense.kind}</Button>
                    <Button className="h-10 px-5" onClick={onEdit}><Pencil />Edit {expense.kind}</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
