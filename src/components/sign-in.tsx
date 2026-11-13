"use client";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, Loader2, MoveUpRight } from "lucide-react";
import type { AuthProviderInfo } from "pocketbase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pb } from "@/lib/pocketbase";
import { errorMessage } from "@/lib/domain";
import { Brand } from "./brand";

export function SignIn() {
    const [providers, setProviders] = useState<AuthProviderInfo[]>([]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState("");
    const [passwordEnabled, setPasswordEnabled] = useState(false);
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    useEffect(() => {
        let active = true;
        pb.collection("users")
            .listAuthMethods()
            .then((methods) => {
                if (active) {
                    setProviders(methods.oauth2.providers);
                    setPasswordEnabled(methods.password.enabled);
                }
            })
            .catch((e) => {
                if (active) setError(errorMessage(e));
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => {
            active = false;
        };
    }, []);
    function signIn(provider: string) {
        setBusy(provider);
        setError("");
        pb.collection("users")
            .authWithOAuth2({ provider })
            .catch((e) => setError(errorMessage(e)))
            .finally(() => setBusy(""));
    }

    async function signInWithPassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        setBusy("password");
        setError("");
        try {
            await pb.collection("users").authWithPassword(email.trim(), password);
            setPassword("");
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setBusy("");
        }
    }

    return (
        <main
            id="main-content"
            className="grid min-h-svh lg:grid-cols-[1.08fr_1fr]">
            <section
                className="relative hidden overflow-hidden border-r lg:block"
                aria-label="Expenditure">
                <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
                    <div className="relative flex size-100 items-center justify-center rounded-full border border-primary/8 xl:size-120">
                        <div className="flex size-72 items-center justify-center rounded-full border border-primary/13 xl:size-86">
                            <MoveUpRight className="size-24 text-primary" strokeWidth={0.65} />
                        </div>
                        <span className="absolute top-[14%] right-[14%] size-2.5 rounded-full bg-primary" />
                    </div>
                </div>
                <div className="relative p-12">
                    <Brand />
                </div>
            </section>
            <section className="relative flex min-h-svh flex-col justify-center px-7 py-12 sm:px-16 xl:px-24">
                <div className="absolute top-9 left-7 lg:hidden">
                    <Brand />
                </div>
                <div className="mx-auto w-full max-w-96 animate-enter">
                    <div aria-hidden="true" className="mb-8 flex h-44 items-center justify-center lg:hidden">
                        <div className="relative flex size-44 items-center justify-center rounded-full border border-primary/8">
                            <div className="flex size-32 items-center justify-center rounded-full border border-primary/13">
                                <MoveUpRight className="size-12 text-primary" strokeWidth={0.8} />
                            </div>
                            <span className="absolute top-[14%] right-[14%] size-1.5 rounded-full bg-primary" />
                        </div>
                    </div>
                    <h1 className="font-display text-[38px] leading-[1.08] font-semibold tracking-[-0.7px] sm:text-5xl">Sign in to<br />Expenditure</h1>
                    <p className="mt-4 text-[15px] leading-6 text-muted-foreground">Track expenses, income, and shared spending.</p>
                    <div className="mt-8 space-y-3">
                        {loading ?
                                (
                                    <Button className="h-12 w-full" disabled>
                                        <Loader2 className="animate-spin" />
                                        Connecting…
                                    </Button>
                                ) :
                                (
                                    providers.map((provider) => (
                                        <Button
                                            key={provider.name}
                                            className="h-12 w-full justify-between px-4"
                                            disabled={!!busy}
                                            onClick={() => signIn(provider.name)}>
                                            Continue with {provider.displayName || provider.name}
                                            {busy === provider.name ?
                                                    (
                                                        <Loader2 className="animate-spin" />
                                                    ) :
                                                    (
                                                        <ArrowRight className="size-4" />
                                                    )}
                                        </Button>
                                    ))
                                )}
                        {!loading && passwordEnabled && (
                            <form className="space-y-3 pt-3" onSubmit={signInWithPassword}>
                                <label className="field-label" htmlFor="login-email">Email</label>
                                <Input
                                    id="login-email"
                                    type="email"
                                    autoComplete="username"
                                    required
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    disabled={!!busy}
                                />
                                <label className="field-label" htmlFor="login-password">Password</label>
                                <Input
                                    id="login-password"
                                    type="password"
                                    autoComplete="current-password"
                                    required
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    disabled={!!busy}
                                    autoCapitalize="none"
                                    spellCheck={false}
                                />
                                <Button type="submit" className="h-12 w-full" disabled={!!busy || !email.trim() || !password}>
                                    {busy === "password" && <Loader2 className="animate-spin" />} Sign in
                                </Button>
                            </form>
                        )}
                        {!loading && !providers.length && !passwordEnabled && !error && (
                            <p role="alert" className="text-sm text-destructive">No sign-in methods are enabled on this server.</p>
                        )}
                        {error && (
                            <p
                                role="alert"
                                className="rounded-lg bg-destructive/10 p-3 text-sm leading-6 text-destructive">
                                {error}
                            </p>
                        )}
                    </div>
                </div>
            </section>
        </main>
    );
}
