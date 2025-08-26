const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const path = require('path'); // Import necessário para path.join

const API_TOKEN = "BLUECHEATMACIEL2025!@#"; // Token seguro para download

// Middleware para autenticar token
function autenticarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ mensagem: "Token não fornecido" });

  const token = authHeader.split(' ')[1]; // espera "Bearer <token>"
  if (token !== API_TOKEN) {
    return res.status(403).json({ mensagem: "Token inválido" });
  }

  next(); // token válido, continua
}

const app = express();
app.use(bodyParser.json());

// Conexão com PostgreSQL
const pool = new Pool({
  user: 'postgres',
  host: 'metro.proxy.rlwy.net',
  database: 'railway',
  password: 'jOYwTBGKjpdzgIKYmNfUsURhLrIUuRVD',
  port: 39715,
});

// Rota de download protegida
app.get('/download', autenticarToken, (req, res) => {
  const exePath = path.join(__dirname, 'epicgamesinstaller.exe'); // caminho completo
  res.download(exePath, 'programa.exe', (err) => {
    if (err) {
      console.error("Erro ao baixar arquivo:", err);
      res.status(500).send("Erro ao baixar arquivo");
    }
  });
});

// Rota de login e verificação de licença
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;

  try {
    // Busca usuário
    const userResult = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1 AND senha = $2',
      [email, senha]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ autorizado: false, mensagem: "Credenciais inválidas" });
    }

    const usuario = userResult.rows[0];

    // Busca licença mais recente
    const licencaResult = await pool.query(
      'SELECT * FROM licencas WHERE usuario_id = $1 ORDER BY data_fim DESC LIMIT 1',
      [usuario.id]
    );

    if (licencaResult.rows.length === 0) {
      return res.json({ autorizado: false, mensagem: "Nenhuma licença encontrada" });
    }

    const licenca = licencaResult.rows[0];
    const hoje = new Date();

    if (hoje <= new Date(licenca.data_fim)) {
      return res.json({ autorizado: true, mensagem: "Licença ativa até " + licenca.data_fim });
    } else {
      return res.json({ autorizado: false, mensagem: "Licença expirada em " + licenca.data_fim });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ autorizado: false, mensagem: "Erro no servidor" });
  }
});

// Inicialização do servidor
app.listen(3001, () => {
  console.log("API rodando na porta 3001");
});
