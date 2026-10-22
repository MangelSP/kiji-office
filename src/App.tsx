import "./App.css";

const NOMBRE = "Alexis";

function saludo(hora: number) {
  if (hora < 12) return "Buenos días";
  if (hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

function App() {
  return (
    <main className="container">
      <p className="marca">KIJI OFFICE</p>
      <h1>
        ¡{saludo(new Date().getHours())}, {NOMBRE}!
      </h1>
      <p className="sub">Tu oficina de robots está lista para empezar.</p>
    </main>
  );
}

export default App;
