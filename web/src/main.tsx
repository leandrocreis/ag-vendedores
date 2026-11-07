import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import "./styles.css";
import { ToastProvider } from "./components/ui";
import { Painel } from "./pages/Painel";
import { NovoVideo } from "./pages/NovoVideo";
import { Projeto } from "./pages/Projeto";
import { Projetos } from "./pages/Projetos";
import { Estilos } from "./pages/Estilos";
import { EstudioVoz } from "./pages/EstudioVoz";
import { Series } from "./pages/Series";
import { Youtube } from "./pages/Youtube";
import { Midia } from "./pages/Midia";
import { Fila } from "./pages/Fila";
import { Configuracoes } from "./pages/Configuracoes";

const MENU: [string, string, string][] = [
  ["/", "▦", "Painel"], ["/novo", "＋", "Novo vídeo"], ["/voz", "🎙", "Estúdio de voz"], ["/estilos", "◐", "Estilos"],
  ["/projetos", "▤", "Projetos"], ["/series", "☰", "Séries"], ["/youtube", "▶", "Canal YouTube"], ["/midia", "🖼", "Biblioteca de mídia"],
  ["/fila", "⏱", "Fila de produção"], ["/config", "⚙", "Configurações"],
];

function App() {
  return (
    <div className="app">
      <aside className="side">
        <div className="brand"><b>?</b> E Se? Studio</div>
        {MENU.map(([to, ic, label]) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `nav ${isActive ? "active" : ""}`}><span className="ic">{ic}</span>{label}</NavLink>)}
        <div className="sp" />
        <div className="tiny muted" style={{ padding: 10 }}>Roda no seu computador. Provedores externos (Anthropic, OpenAI, RunPod) aparecem identificados em cada etapa.</div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Painel />} />
          <Route path="/novo" element={<NovoVideo />} />
          <Route path="/projetos" element={<Projetos />} />
          <Route path="/projetos/:id" element={<Projeto />} />
          <Route path="/estilos" element={<Estilos />} />
          <Route path="/voz" element={<EstudioVoz />} />
          <Route path="/series" element={<Series />} />
          <Route path="/youtube" element={<Youtube />} />
          <Route path="/midia" element={<Midia />} />
          <Route path="/fila" element={<Fila />} />
          <Route path="/config" element={<Configuracoes />} />
        </Routes>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><ToastProvider><BrowserRouter><App /></BrowserRouter></ToastProvider></StrictMode>);
