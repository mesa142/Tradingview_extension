const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.json());

// Serve static files from root directory
app.use(express.static(__dirname, {
  extensions: ['html', 'js', 'json', 'css', 'png', 'svg'],
  index: false // we handle / explicitly
}));

// API: Get status & metadata
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    app: 'TradingView OHLC Extractor',
    version: '1.3.0',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// API: Run test suite and stream output
app.get('/api/run-tests', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const testProcess = spawn('node', ['tests/run.js'], { cwd: __dirname });

  testProcess.stdout.on('data', (data) => {
    res.write(data);
  });

  testProcess.stderr.on('data', (data) => {
    res.write(data);
  });

  testProcess.on('close', (code) => {
    res.write(`\nTest process exited with code ${code}\n`);
    res.end();
  });
});

// API: List sample CSV files
app.get('/api/samples', (req, res) => {
  try {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.csv'));
    const samples = files.map(filename => {
      const filePath = path.join(__dirname, filename);
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n');
      return {
        name: filename,
        sizeBytes: stat.size,
        rows: Math.max(0, lines.length - 1),
        header: lines[0] || '',
        preview: lines.slice(0, 6)
      };
    });
    res.json({ samples });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Root: serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fallback for popup.html
app.get('/popup', (req, res) => {
  res.sendFile(path.join(__dirname, 'popup.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`TradingView OHLC Extractor server running at http://${HOST}:${PORT}`);
});
