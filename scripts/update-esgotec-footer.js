const db = require('sqlite3').verbose();
const d = new db.Database('crm.db');
const logo = 'https://solucaodesentupidora.contrateagora.com/assets/images/LOGO.png';
const wa = 'https://wa.me/556593331978';
const tel = 'tel:+556593331978';
const html = [
'<div class="container footer-grid" style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:30px;">',
'  <div class="footer-col marca">',
'    <img src="' + logo + '" alt="Esgotec Desentupidora" style="max-width:200px;height:auto;margin-bottom:16px;border-radius:4px;background:rgba(255,255,255,0.05);padding:8px;">',
'    <p class="footer-desc" style="font-size:14px;line-height:1.8;color:#d1d5db;">Especialistas em desentupimento com eficiência, transparência e preço justo. A melhor tecnologia para manter o fluxo perfeito em residências e indústrias no Mato Grosso</p>',
'    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;">',
'      <span style="background:rgba(230,57,70,0.15);border:1px solid rgba(230,57,70,0.3);color:#FCA5A5;font-size:11px;padding:4px 10px;border-radius:6px;">Atendimento 24h</span>',
'      <span style="background:rgba(230,57,70,0.15);border:1px solid rgba(230,57,70,0.3);color:#FCA5A5;font-size:11px;padding:4px 10px;border-radius:6px;">Sem Quebra</span>',
'   </div>',
' </div>',
'  <div class="footer-col links">',
'    <h4 class="footer-title"><i class="fa-solid fa-layer-group</i> Nossos Serviços</h4>',
'    <ul class="footer-links" style="list-style:none;padding:0;margin:0;">',
'      <li><a href="' + wa + '" target="_blank" rel="noopener"><i class="fa-solid fa-chevron-right</i> Pias e Ralos</a</li>',
'      <li><a href="' + wa + '" target="_blank" rel="noopener"><i class="fa-solid fa-chevron-right</i> Vasos Sanitários</a</li>',
'      <li><a href="' + wa + '" target="_blank" rel="noopener"><i class="fa-solid fa-chevron-right</i> Esgoto e Colunas</a</li>',
'      <li><a href="' + wa + '" target="_blank" rel="noopener"><i class="fa-solid fa-chevron-right</i> Caixa de Gordura</a</li>',
'      <li><a href="' + wa + '" target="_blank" rel="noopener"><i class="fa-solid fa-chevron-right</i> Hidrojateamento</a</li>',
'   </ul>',
' </div>',
'  <div class="footer-col contato">',
'    <h4 class="footer-title"><i class="fa-solid fa-headset</i> Atendimento</h4>',
'    <ul class="footer-contact-info" style="list-style:none;padding:0;margin:0;">',
'      <li style="display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;">',
'        <span style="width:36px;height:36px;border-radius:50%;background:rgba(230,57,70,0.15);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fa-solid fa-location-dot" style="color:#E63946</i</span>',
'        <span><strong>Área</strong><br>Cuiabá e Várzea Grande - MT</span>',
'     </li>',
'      <li style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">',
'        <span style="width:36px;height:36px;border-radius:50%;background:rgba(230,57,70,0.15);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fa-solid fa-phone" style="color:#E63946</i</span>',
'        <a href="' + tel + '" style="color:#fff;font-weight:700;">(65) 9333-1978</a>',
'     </li>',
'      <li style="display:flex;gap:12px;align-items:center;margin-bottom:12px;">',
'        <span style="width:36px;height:36px;border-radius:50%;background:rgba(34,197,94,0.15);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fa-brands fa-whatsapp" style="color:#22C55E</i</span>',
'        <a href="' + wa + '" target="_blank" rel="noopener" style="font-weight:600;">Solicitar Orçamento Zap</a>',
'     </li>',
'   </ul>',
' </div>',
'  <div class="footer-col social">',
'    <h4 class="footer-title">Redes</h4>',
'    <div style="display:flex;gap:12px;margin-top:10px;">',
'      <a href="' + wa + '" target="_blank" rel="noopener" style="width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(34,197,94,0.15);color:#22C55E;font-size:20px;"><i class="fa-brands fa-whatsapp</i</a>',
'      <a href="#" style="width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(230,57,70,0.15);color:#E63946;font-size:20px;"><i class="fa-brands fa-instagram</i</a>',
'      <a href="#" style="width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(59,130,246,0.15);color:#3B82F6;font-size:20px;"><i class="fa-brands fa-facebook</i</a>',
'   </div>',
'    <a href="' + wa + '" target="_blank" rel="noopener" style="display:inline-block;margin-top:16px;padding:12px 20px;background:#E63946;color:#fff;font-weight:700;text-decoration:none;border-radius:6px;"><i class="fa-brands fa-whatsapp</i> Atendimento 24h</a>',
' </div>',
</div>',
'<div class="footer-bottom text-center" style="text-align:center;padding:20px;font-size:12px;background-color:#000812;color:#9CA3AF;">',
'  <p>&copy; 2026 Esgotec Desentupidora. Todos os direitos reservados</p>',
'  <p style="margin-top:6px;"><i class="fa-solid fa-droplet" style="color:#E63946</i> Esgotec rápida e sem sujeira</p>',
</div>'
].join('');
d.run('UPDATE clients SET footer_html=? WHERE slug=?', [html, 'esgotec-desentupidora'], function(err) {
  if (err) console.log('ERR', err.message);
  else console.log('footer_html OK, rows:', this.changes);
});
