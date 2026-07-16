FROM python:3.12-alpine

WORKDIR /app

COPY server.py /app/server.py

ENV LISTEN_HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["python", "/app/server.py"]
