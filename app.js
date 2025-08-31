const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const path = require('path'); // Import necessário para path.join
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();



const API_TOKEN = process.env.TOKENAPI; // Token seguro para download
const LIVEPIX_CLIENT_ID = process.env.LIVEPIX_CLIENT_ID;
const LIVEPIX_CLIENT_SECRET = process.env.LIVEPIX_CLIENT_SECRET;

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

const app = express(); // cria o app primeiro
app.use(cors());       // só depois usa
app.use(bodyParser.json());


// Conexão com PostgreSQL
const pool = new Pool({
  user: 'postgres',
  host: 'metro.proxy.rlwy.net',
  database: 'railway',
  password: 'jOYwTBGKjpdzgIKYmNfUsURhLrIUuRVD',
  port: 39715,
});

let livePixToken = null;
let tokenExpiration = null;

async function getLivePixToken() {
  if (livePixToken && tokenExpiration && Date.now() < tokenExpiration) {
    return livePixToken;
  }

  try {
    const params = new URLSearchParams();
    params.append("grant_type", "client_credentials");
    params.append("client_id", LIVEPIX_CLIENT_ID);
    params.append("client_secret", LIVEPIX_CLIENT_SECRET);
    params.append("scope", "payments:read payments:write account:read"); // Múltiplos escopos

    const response = await axios.post("https://oauth.livepix.gg/oauth2/token", params, {
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      }
    });

    console.log("Token obtido com sucesso. Scope:", response.data.scope);
    
    livePixToken = response.data.access_token;
    tokenExpiration = Date.now() + (response.data.expires_in * 1000 || 3600000);
    
    return livePixToken;
  } catch (error) {
    console.error("Erro ao obter token LivePix:", error.response?.data || error.message);
    throw error;
  }
}






const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;


// Função para consultar pagamento na LivePix
async function consultarPagamento(reference) {
  try {
    const token = await getLivePixToken();

    const response = await axios.get("https://api.livepix.gg/v2/payments", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      },
      params: { reference }
    });

    return response.data;
  } catch (err) {
    // Se for erro 401, limpa o cache do token e tenta novamente
    if (err.response?.status === 401) {
      console.log("Token expirado, limpando cache e tentando novamente...");
      livePixToken = null;
      tokenExpiration = null;
      
      // Tenta uma vez mais com novo token
      const token = await getLivePixToken();
      const response = await axios.get("https://api.livepix.gg/v2/payments", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        },
        params: { reference }
      });
      
      return response.data;
    }
    
    console.error("Erro ao consultar pagamento:", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message
    });
    throw err;
  }
}

// Rota para receber o code do Discord e trocar pelo token
app.post('/auth/discord', async (req, res) => {
  const { code } = req.body;

  if (!code) return res.status(400).json({ error: 'Code não fornecido' });

  try {
    // Troca code pelo access_token
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', REDIRECT_URI);

    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenResponse.data;

    // Buscar dados do usuário no Discord
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const discordUser = userResponse.data;

    // Salvar ou atualizar no banco
    const query = `
      INSERT INTO usuarios (discord_id, discord_username, discord_avatar)
      VALUES ($1, $2, $3)
      ON CONFLICT (discord_id)
      DO UPDATE SET discord_username = EXCLUDED.discord_username,
                    discord_avatar = EXCLUDED.discord_avatar
      RETURNING *;
    `;

    const result = await pool.query(query, [
      discordUser.id,
      discordUser.username,
      `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    ]);

    const usuario = result.rows[0];

    return res.json({
      usuario,
      token: access_token
    });

  } catch (err) {
    console.error("Erro ao trocar code pelo token:", err.response?.data || err.message);
    return res.status(500).json({ error: err.response?.data || err.message });
  }

});



// Rota pública GET
app.get('/', (req, res) => {
  res.send("API BlueCheat funcionando");
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
app.post('/login', autenticarToken, async (req, res) => {
  const { email, senha, hwid } = req.body;

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

    if (hoje > new Date(licenca.data_fim)) {
      return res.json({ autorizado: false, mensagem: "Licença expirada em " + licenca.data_fim });
    }

    // Controle de HWID
    if (!licenca.hwid) {
      // primeira ativação: grava o hwid enviado
      await pool.query(
        'UPDATE licencas SET hwid = $1 WHERE id = $2',
        [hwid, licenca.id]
      );
    } else if (licenca.hwid !== hwid) {
      // HWID diferente → nega acesso
      return res.json({ autorizado: false, mensagem: "Licença já está vinculada a outro computador" });
    }

    // Tudo ok
    return res.json({ autorizado: true, mensagem: "Licença ativa até " + licenca.data_fim });

  } catch (err) {
    console.error(err);
    res.status(500).json({ autorizado: false, mensagem: "Erro no servidor" });
  }
});


app.post('/usuarios/updatePreco', autenticarToken, async (req, res) => {
  const { discord_id, preco_escolhido } = req.body;
  console.log("Recebido updatePreco:", req.body);

  if (!discord_id || preco_escolhido === undefined) {
    return res.status(400).json({ sucesso: false, mensagem: "Dados incompletos" });
  }

  try {
    console.log(`Tentando atualizar preco_escolhido = ${preco_escolhido} para discord_id = ${discord_id}`);

    const result = await pool.query(
      `UPDATE usuarios
       SET preco_escolhido = $1
       WHERE discord_id = $2
       RETURNING *;`,
      [preco_escolhido, discord_id]
    );

    console.log("Resultado do UPDATE:", result.rows);

    if (result.rows.length === 0) {
      console.log("Usuário não encontrado, criando novo:", discord_id, preco_escolhido);

      const insertResult = await pool.query(
        `INSERT INTO usuarios (discord_id, preco_escolhido) VALUES ($1, $2) RETURNING *`,
        [discord_id, preco_escolhido]
      );

      console.log("Resultado do INSERT:", insertResult.rows);
      return res.json({ sucesso: true, usuario: insertResult.rows[0] });
    }

    res.json({ sucesso: true, usuario: result.rows[0] });
  } catch (err) {
    console.error("Erro no updatePreco:", err);
    res.status(500).json({ sucesso: false, mensagem: "Erro no servidor" });
  }
});





// Adicione esta rota no seu app.js (API)
app.get('/usuarios/preco/:discord_id', autenticarToken, async (req, res) => {
  const { discord_id } = req.params;

  try {
    const result = await pool.query(
      'SELECT preco_escolhido FROM usuarios WHERE discord_id = $1',
      [discord_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ mensagem: "Usuário não encontrado" });
    }

    res.json({ preco_escolhido: result.rows[0].preco_escolhido });
  } catch (err) {
    console.error(err);
    res.status(500).json({ mensagem: "Erro no servidor" });
  }
});

app.post('/usuarios/updateInfo', autenticarToken, async (req, res) => {
  const { discord_id, email, nome, sobrenome, cpf, numero_residencia, cep, complemento, senha, checkbox1, checkbox2 } = req.body;

  if (!discord_id || !email || !nome || !sobrenome || !cpf || !numero_residencia || !cep || !complemento || !senha) {
    return res.status(400).json({ sucesso: false, mensagem: "Dados incompletos" });
  }

  try {
    const result = await pool.query(
      `UPDATE usuarios
       SET email = $1,
           nome = $2,
           sobrenome = $3,
           cpf = $4,
           numero_residencia = $5,
           cep = $6,
           complemento = $7,
           senha = $8,               -- adiciona aqui
           termo1_preenchido = $9,
           termo2_preenchido = $10
       WHERE discord_id = $11
       RETURNING *;`,
      [email, nome, sobrenome, cpf, numero_residencia, cep, complemento, senha, checkbox1, checkbox2, discord_id]
    );

    if (result.rows.length === 0) {
      console.error("usuario não encontrado")
      return res.status(404).json({ sucesso: false, mensagem: "Usuário não encontrado" });
    }

    res.json({ sucesso: true, usuario: result.rows[0] });
  } catch (err) {
    console.error("Erro ao atualizar informações do usuário:", err);
    res.status(500).json({ sucesso: false, mensagem: "Erro no servidor" });
  }
});



app.post("/pagamentos/criar", autenticarToken, async (req, res) => {
  const { discord_id, amount } = req.body;

  if (!discord_id || !amount) {
    return res.status(400).json({ sucesso: false, mensagem: "Dados incompletos" });
  }

  try {
    const token = await getLivePixToken();

    const pagamentoData = {
      amount: Math.round(amount * 100),
      currency: "BRL",
      redirectUrl: "https://bluecheat-front.vercel.app/sucesso",
      metadata: { discord_id, timestamp: new Date().toISOString() }
    };

    const pagamentoResponse = await axios.post(
      "https://api.livepix.gg/v2/payments", 
      pagamentoData,
      {
        headers: { 
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        }
      }
    );

    const { reference, redirectUrl } = pagamentoResponse.data.data;

    // CORREÇÃO: Use reference como payment_id, já que a API não retorna um id separado
    const result = await pool.query(
      `INSERT INTO pagamentos (discord_id, amount, currency, reference, payment_id, redirect_url, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [discord_id, amount, "BRL", reference, reference, redirectUrl, "pendente"] // Use reference como payment_id
    );

    return res.json({ 
      sucesso: true, 
      pagamento: result.rows[0],
      redirect_url: redirectUrl
    });

  } catch (err) {
    console.error("Erro ao criar pagamento:", err.response?.data || err.message);
    return res.status(500).json({ sucesso: false, mensagem: "Erro ao criar pagamento" });
  }
});




// Consulta apenas no banco de dados (sem verificação na API)
app.get('/pagamentos/consultar/:discord_id', autenticarToken, async (req, res) => {
  const { discord_id } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM pagamentos
       WHERE discord_id = $1
       ORDER BY criado_em DESC
       LIMIT 1`,
      [discord_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ sucesso: false, mensagem: "Nenhum pagamento encontrado" });
    }

    const pagamento = result.rows[0];
    
    // Apenas retorna o status do banco, SEM consultar a API
    res.json({ 
      sucesso: true, 
      pagamento,
      mensagem: "Status consultado apenas no banco de dados local"
    });
    
  } catch (err) {
    console.error("Erro ao consultar pagamento:", err);
    res.status(500).json({ sucesso: false, mensagem: "Erro no servidor" });
  }
});

/* ---------------- JOB AUTOMÁTICO ---------------- */

// Verifica pagamentos pendentes a cada 2 minutos
setInterval(async () => {
  try {
    const pendentes = await pool.query(
      `SELECT * FROM pagamentos WHERE status = 'pendente'`
    );

    console.log(`Encontrados ${pendentes.rows.length} pagamentos pendentes`);

    for (const pagamento of pendentes.rows) {
      try {
        console.log(`Verificando pagamento: ${pagamento.reference}`);
        
        const consulta = await consultarPagamento(pagamento.reference);

        if (consulta.data && consulta.data.length > 0) {
          console.log(`✅ Pagamento confirmado na LivePix: ${pagamento.reference}`);
          
          // Use reference para o UPDATE
          const result = await pool.query(
            `UPDATE pagamentos SET status = 'concluido' WHERE reference = $1 RETURNING *`,
            [pagamento.reference]
          );
          
          if (result.rowCount > 0) {
            console.log(`✅ Pagamento ${pagamento.reference} atualizado para concluído`);
          } else {
            console.log(`❌ Nenhum registro atualizado para reference: ${pagamento.reference}`);
          }
        } else {
          console.log(`⏳ Pagamento ${pagamento.reference} ainda pendente na LivePix`);
        }
      } catch (err) {
        console.error(`Erro ao verificar pagamento ${pagamento.reference}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Erro no job de verificação:", err);
  }
}, 30000);

// Função para criar ou atualizar licença
async function criarOuAtualizarLicenca(discord_id, amount) {
  try {
    // Primeiro, buscar o usuário pelo discord_id
    const usuarioResult = await pool.query(
      `SELECT id, preco_escolhido FROM usuarios WHERE discord_id = $1`,
      [discord_id]
    );

    if (usuarioResult.rows.length === 0) {
      console.log(`❌ Usuário com discord_id ${discord_id} não encontrado`);
      return;
    }

    const usuario = usuarioResult.rows[0];
    const usuario_id = usuario.id;
    
    // Determinar o plano com base no preço_escolhido OU no amount do pagamento
    const preco = usuario.preco_escolhido || amount;
    const { plano, dataFim } = determinarPlanoEDataFim(preco);

    console.log(`📋 Criando/atualizando licença para usuário ${usuario_id}: ${plano}`);

    // Verificar se já existe uma licença ativa para este usuário
    const licencaExistente = await pool.query(
      `SELECT id FROM licencas WHERE usuario_id = $1 AND data_fim > NOW()`,
      [usuario_id]
    );

    if (licencaExistente.rows.length > 0) {
      // Se já existe licença ativa, atualizar a data_fim
      await pool.query(
        `UPDATE licencas 
         SET data_fim = $1, plano = $2, data_inicio = NOW()
         WHERE usuario_id = $3 AND data_fim > NOW()`,
        [dataFim, plano, usuario_id]
      );
      console.log(`✅ Licença atualizada para usuário ${usuario_id}`);
    } else {
      // Se não existe, criar nova licença
      await pool.query(
        `INSERT INTO licencas (usuario_id, plano, data_inicio, data_fim)
         VALUES ($1, $2, NOW(), $3)`,
        [usuario_id, plano, dataFim]
      );
      console.log(`✅ Nova licença criada para usuário ${usuario_id}`);
    }

  } catch (err) {
    console.error(`❌ Erro ao criar/atualizar licença para ${discord_id}:`, err.message);
  }
}

// Função auxiliar para determinar plano e data fim
function determinarPlanoEDataFim(preco) {
  const hoje = new Date();
  let plano, dataFim;

  switch (preco) {
    case 1: // Semanal
      plano = "semanal";
      dataFim = new Date(hoje.setDate(hoje.getDate() + 7));
      break;
    case 40: // Mensal
      plano = "mensal";
      dataFim = new Date(hoje.setMonth(hoje.getMonth() + 1));
      break;
    case 80: // Trimestral
      plano = "trimestral";
      dataFim = new Date(hoje.setMonth(hoje.getMonth() + 3));
      break;
    case 200: // Anual
      plano = "anual";
      dataFim = new Date(hoje.setFullYear(hoje.getFullYear() + 1));
      break;
    default:
      // Valor padrão se não reconhecer o preço
      plano = "mensal";
      dataFim = new Date(hoje.setMonth(hoje.getMonth() + 1));
  }

  return { plano, dataFim };
}



// Inicialização do servidor
app.listen(3001, () => {
  console.log("API rodando na porta 3001");
});
