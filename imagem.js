const express = require('express');
const sharp = require('sharp');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.get('/api/imagem', async (req, res) => {
    const titulo = req.query.q;
    
    if (!titulo) {
        return res.status(400).json({ erro: 'Por favor, envie um título. Ex: /api/imagem?q=Como desentupir pia' });
    }

    try {
        console.log(`Buscando imagem para: "${titulo}"...`);

        // 1. Obtém o token do DuckDuckGo
        const respostaHtml = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(titulo)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const html = await respostaHtml.text();
        const vqdMatch = html.match(/vqd=["']?([^"'\s&]+)/);
        
        if (!vqdMatch) return res.status(500).json({ erro: 'Token VQD não encontrado.' });
        const vqd = vqdMatch[1];

        // 2. Busca o JSON de imagens
        const respostaImagens = await fetch(`https://duckduckgo.com/i.js?q=${encodeURIComponent(titulo)}&o=json&vqd=${vqd}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        
        const json = await respostaImagens.json();
        const dadosImagens = json.results;

        if (dadosImagens && dadosImagens.length > 0) {
            
            // 3. Filtro de Qualidade Extreme
            const sitesRuins = ['pinterest', 'youtube', 'tiktok', 'facebook', 'dailymotion'];
            let imagensFiltradas = dadosImagens.filter(img => {
                const urlLimpa = !sitesRuins.some(ruim => img.image.toLowerCase().includes(ruim));
                return urlLimpa && img.width >= img.height && img.width >= 1200;
            });

            if (imagensFiltradas.length === 0) {
                 imagensFiltradas = dadosImagens.filter(img => !sitesRuins.some(ruim => img.image.toLowerCase().includes(ruim)) && img.width >= img.height && img.width >= 800);
            }
            if (imagensFiltradas.length === 0) {
                imagensFiltradas = dadosImagens.filter(img => img.width >= img.height);
            }
            if (imagensFiltradas.length === 0) imagensFiltradas = dadosImagens;

            imagensFiltradas.sort((a, b) => (b.width * b.height) - (a.width * a.height));
            const top3 = imagensFiltradas.slice(0, 3);
            const imagemEscolhida = top3[Math.floor(Math.random() * top3.length)];

            console.log(`Baixando imagem original (${imagemEscolhida.width}x${imagemEscolhida.height})...`);

            // 4. SISTEMA DE MARCA D'ÁGUA COM SHARP
            // Baixa a imagem escolhida da internet para a memória (buffer)
            const imagemResponse = await fetch(imagemEscolhida.image);
            const imagemArrayBuffer = await imagemResponse.arrayBuffer();
            const bufferOriginal = Buffer.from(imagemArrayBuffer);

            // Carrega a imagem principal no Sharp
            const imagemPrincipal = sharp(bufferOriginal);
            const metadata = await imagemPrincipal.metadata();

            // Verifica se o arquivo logo.png existe
            if (fs.existsSync('logo.png')) {
                // Calcula o tamanho da logo (ex: 15% da largura da imagem principal)
                const tamanhoLogo = Math.round(metadata.width * 0.15);
                
                // Calcula uma margem de 3% para não ficar grudada na borda
                const margem = Math.round(metadata.width * 0.03);

                // Prepara a logo redimensionada
                const logoBuffer = await sharp('logo.png')
                    .resize({ width: tamanhoLogo })
                    .toBuffer();
                
                const logoMetadata = await sharp(logoBuffer).metadata();

                // Calcula a posição exata do Canto Inferior Direito (Bottom Right)
                const posicaoTop = metadata.height - logoMetadata.height - margem;
                const posicaoLeft = metadata.width - logoMetadata.width - margem;

                // Aplica a marca d'água na imagem principal
                imagemPrincipal.composite([{ 
                    input: logoBuffer, 
                    top: posicaoTop, 
                    left: posicaoLeft 
                }]);
            } else {
                console.log("Aviso: logo.png não encontrada. Retornando sem marca d'água.");
            }

            // Converte o resultado final para JPEG e depois para Base64
            const bufferFinal = await imagemPrincipal.jpeg({ quality: 85 }).toBuffer();
            const base64Image = `data:image/jpeg;base64,${bufferFinal.toString('base64')}`;

            console.log('Imagem processada e pronta!');
            
            res.json({ 
                sucesso: true, 
                imagemBase64: base64Image, // Imagem final já com a logo em Base64
                titulo: imagemEscolhida.title,
                fonte: imagemEscolhida.url
            });
        } else {
            res.status(404).json({ sucesso: false, erro: 'Nenhuma imagem retornada no JSON.' });
        }

    } catch (erro) {
        console.error("Erro capturado:", erro.message);
        res.status(500).json({ sucesso: false, erro: 'Erro interno ao processar a imagem.' });
    }
});

app.listen(PORT, () => {
    console.log(`API rodando! Teste acessando: http://localhost:${PORT}/api/imagem?q=Como%20desentupir%20pia`);
});