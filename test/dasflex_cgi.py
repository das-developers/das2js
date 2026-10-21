#!/usr/bin/env python3
"""Minimal HTTP front end for a dasFlex build tree, no Apache required.

dasFlex is a CGI program: Apache sets environment variables, runs
dasflex_cgimain, and relays its stdout.  This does the same over a local
port so the browser tests can talk to the dasFlex checkout next door and
so header behavior can be inspected without a web server install.  It is a
test fixture, not a server: single threaded, no auth, no TLS.

Usage:
    dasflex_cgi.py [--root DIR] [--port N]

--root is the dasFlex build tree holding test_srv/ (default ../dasflex,
relative to the das2js checkout).  Port 0 picks a free one; the chosen
port is printed as the first line of output, which a caller can read.

The URL space mirrors the test_srv config: SERVER_URL there is
http://localhost/das/server, so requests look like
    http://127.0.0.1:PORT/das/server/source/examples/spectra/flex?read.time.min=...
"""

import argparse
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT_NAME = '/das/server'

class Handler(BaseHTTPRequestHandler):
	protocol_version = 'HTTP/1.1'
	root = None   # set before serving

	def _run(self):
		url = urlsplit(self.path)
		if not url.path.startswith(SCRIPT_NAME):
			self.send_error(404, 'only %s/... is served'%SCRIPT_NAME)
			return

		srv = os.path.join(self.root, 'test_srv')
		env = {
			'PATH': os.environ.get('PATH', '/usr/bin'),
			'HOME': os.environ.get('HOME', '/'),
			'DASFLEX_CONFIG': os.path.join(srv, 'etc', 'dasflex.conf'),
			'SCRIPT_FILENAME': os.path.join(srv, 'bin', 'dasflex_cgimain'),
			'SCRIPT_NAME': SCRIPT_NAME,
			'SERVER_NAME': '127.0.0.1',
			'SERVER_PORT': str(self.server.server_address[1]),
			'SERVER_PROTOCOL': self.protocol_version,
			'GATEWAY_INTERFACE': 'CGI/1.1',
			'REQUEST_METHOD': self.command,
			'PATH_INFO': url.path[len(SCRIPT_NAME):],
			'QUERY_STRING': url.query,
			'REMOTE_ADDR': self.client_address[0],
		}
		# Request headers become HTTP_* variables, as Apache does it
		for k, v in self.headers.items():
			env['HTTP_' + k.upper().replace('-', '_')] = v
		# Apache strips Authorization from the CGI environment; dasFlex's
		# documented RewriteRule puts it back as HTTP_AUTHORIZATION, and when
		# the client sent none the rule yields an EMPTY variable, not a
		# missing one.  dasFlex treats "missing" as a server misconfiguration
		# (500) and "empty" as "not logged in" (401), so mimic the rule.
		env.setdefault('HTTP_AUTHORIZATION', '')
		if 'Content-Type' in self.headers:
			env['CONTENT_TYPE'] = self.headers['Content-Type']
		if 'Content-Length' in self.headers:
			env['CONTENT_LENGTH'] = self.headers['Content-Length']

		body = b''
		n = int(self.headers.get('Content-Length', 0) or 0)
		if n > 0:
			body = self.rfile.read(n)

		proc = subprocess.run(
			[env['SCRIPT_FILENAME']], env=env, input=body,
			stdout=subprocess.PIPE, stderr=subprocess.PIPE
		)

		out = proc.stdout
		# Split CGI headers from the body.  CGI programs may use \r\n or \n.
		sep = b'\r\n\r\n'
		i = out.find(sep)
		j = out.find(b'\n\n')
		if j != -1 and (i == -1 or j < i):
			i, sep = j, b'\n\n'
		if i == -1:
			# No header block at all: the program crashed before output
			self.send_response(500)
			self.send_header('Content-Type', 'text/plain')
			msg = b'CGI produced no headers\n\n' + out + b'\n--- stderr ---\n' + proc.stderr
			self.send_header('Content-Length', str(len(msg)))
			self.end_headers()
			self.wfile.write(msg)
			self.log_message('CGI crash, exit %d', proc.returncode)
			return

		hdr_text = out[:i].decode('latin-1')
		payload = out[i + len(sep):]

		status = 200
		hdrs = []
		for line in hdr_text.split('\n'):
			line = line.rstrip('\r')
			if not line:
				continue
			k, _, v = line.partition(':')
			if k.strip().lower() == 'status':
				status = int(v.strip().split()[0])
			else:
				hdrs.append((k.strip(), v.strip()))

		self.send_response(status)
		for k, v in hdrs:
			self.send_header(k, v)
		self.send_header('Content-Length', str(len(payload)))
		self.end_headers()
		self.wfile.write(payload)
		if proc.stderr:
			sys.stderr.write(proc.stderr.decode('utf-8', 'replace'))

	def do_GET(self):     self._run()
	def do_HEAD(self):    self._run()
	def do_POST(self):    self._run()
	def do_OPTIONS(self): self._run()

def main():
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('--root', default=os.path.join(HERE, '..', '..', 'dasflex'))
	ap.add_argument('--port', type=int, default=0)
	args = ap.parse_args()

	Handler.root = os.path.abspath(args.root)
	if not os.path.isdir(os.path.join(Handler.root, 'test_srv')):
		sys.exit('no test_srv/ under %s; build dasFlex (make test_srv) or pass --root'%Handler.root)

	httpd = HTTPServer(('127.0.0.1', args.port), Handler)
	print(httpd.server_address[1], flush=True)
	try:
		httpd.serve_forever()
	except KeyboardInterrupt:
		pass

if __name__ == '__main__':
	main()
