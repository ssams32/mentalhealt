import * as React from "react";
import { ErrorInfo, ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class SimpleErrorBoundary extends (React.Component as any) {
    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error in 2.5D Engine:", error, errorInfo);
    }

    private handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    public render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }
            return (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 bg-slate-50 border border-slate-200 rounded-xl text-center">
                    <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
                    <h2 className="text-xl font-bold text-slate-800 mb-2">Graphic Engine Error</h2>
                    <p className="text-slate-600 mb-6 max-w-md">
                        The 2.5D Isometric Engine encountered a critical error.
                        <br />
                        <span className="text-xs text-red-400 font-mono mt-2 block bg-slate-100 p-2 rounded">
                            {this.state.error?.message}
                        </span>
                    </p>
                    <button
                        onClick={this.handleReset}
                        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-lg"
                    >
                        <RefreshCw size={16} /> Reload Engine
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
