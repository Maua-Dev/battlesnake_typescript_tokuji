// Bem-vindo ao
// __________         __    __  .__                               __
// \______   \_____ _/  |__/  |_|  |   ____   ______ ____ _____  |  | __ ____
//  |    |  _/\__  \   __\   __\  | _/ __ \ /  ___//    \__  \ |  |/ // __ \
//  |    |   \ / __ \|  |  |  | |  |_\  ___/ \___ \|   |  \/ __ \|    <\  ___/
//  |________/(______/__|  |__| |____/\_____>______>___|__(______/__|__\_____>
//
// Estratégia (pensada para partidas com 4+ cobras): descarta o que mata na
// hora, evita becos (flood fill) e head-to-head com cobras maiores, e só busca
// comida quando está com fome ou não é a maior da mesa.
// Documentação: https://docs.battlesnake.com

import { GameState, Coord, Snake } from "./models";

// GET / — chamado quando você cadastra a cobra no site e a cada partida.
// Controla a aparência dela. Opções de cabeça, cauda e cor:
// https://docs.battlesnake.com/guides/customizations
export function info(): object {
  if (process.env.DEBUG === "true") {
    console.log("INFO");
  }

  return {
    apiversion: "1",
    author: "Tokuji",
    color: "#0077B6", // ciano escuro / azul petróleo
    head: "sand-worm",
    tail: "round-bum",
    version: "1.0.0",
  };
}

// POST /start — chamado uma vez, quando a partida começa.
export function start(gameState: GameState): void {
  console.log(`JOGO COMEÇOU (partida ${gameState.game.id})`);
}

// POST /end — chamado uma vez, quando a partida termina.
export function end(gameState: GameState): void {
  console.log(`FIM DE JOGO após ${gameState.turn} turnos`);
}

const MOVES: Array<[string, number, number]> = [
  ["up", 0, 1],
  ["down", 0, -1],
  ["left", -1, 0],
  ["right", 1, 0],
];

// Pesos da pontuação. Ordem de gravidade: beco > head-to-head > o resto.
const TRAP = -1000; // espaço alcançável menor que o nosso corpo
const H2H_BIGGER = -500; // casa que um adversário maior alcança junto com a gente
const H2H_EQUAL = -300; // empate de tamanho: morrem os dois
const H2H_SMALLER = 10; // adversário menor: o head-to-head é nosso
const HAZARD = -20;
const HUNGER_MARGIN = 15; // vida que queremos sobrando ao chegar na comida

const same = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;
const distance = (a: Coord, b: Coord) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Casas ocupadas do tabuleiro neste turno. */
class Grid {
  private blocked: boolean[];

  constructor(private w: number, private h: number, snakes: Snake[]) {
    this.blocked = new Array(w * h).fill(false);
    for (const snake of snakes) {
      // A cauda sai do lugar neste turno, a não ser que a cobra tenha
      // acabado de comer (aí os dois últimos segmentos ficam empilhados).
      const n = snake.body.length;
      const tailMoves = n >= 2 && !same(snake.body[n - 1], snake.body[n - 2]);
      const solid = tailMoves ? snake.body.slice(0, n - 1) : snake.body;
      for (const c of solid) {
        if (this.inside(c)) this.blocked[this.idx(c)] = true;
      }
    }
  }

  inside(c: Coord): boolean {
    return c.x >= 0 && c.y >= 0 && c.x < this.w && c.y < this.h;
  }

  private idx(c: Coord): number {
    return c.y * this.w + c.x;
  }

  free(c: Coord): boolean {
    return this.inside(c) && !this.blocked[this.idx(c)];
  }

  /**
   * BFS a partir de `start`: chama `visit(casa, distância)` para cada casa
   * livre alcançável; para quando `visit` devolver true.
   */
  // ponytail: os corpos ficam parados no BFS; casas que liberam com o tempo
  // (caudas andando) não contam. Pessimista em espaço apertado.
  bfs(start: Coord, visit: (c: Coord, d: number) => boolean): void {
    const seen = new Array(this.w * this.h).fill(false);
    const queue: Array<[Coord, number]> = [[start, 0]];
    seen[this.idx(start)] = true;
    for (let head = 0; head < queue.length; head++) {
      const [c, d] = queue[head];
      if (visit(c, d)) return;
      for (const [, dx, dy] of MOVES) {
        const next = { x: c.x + dx, y: c.y + dy };
        if (this.free(next) && !seen[this.idx(next)]) {
          seen[this.idx(next)] = true;
          queue.push([next, d + 1]);
        }
      }
    }
  }
}

// POST /move — chamado a cada turno. Aqui mora a inteligência da sua cobra.
// Precisa devolver "up", "down", "left" ou "right".
// Exemplo do JSON recebido: https://docs.battlesnake.com/api/example-move
//
// Cada direção que não mata na hora ganha uma nota; vence a maior.
export function move(gameState: GameState): { move: string } {
  const me = gameState.you;
  const head = me.body[0];
  const { width, height, food } = gameState.board;
  const hazards = gameState.board.hazards ?? [];
  const grid = new Grid(width, height, gameState.board.snakes);
  const opponents = gameState.board.snakes.filter((s) => s.id !== me.id);
  const biggestOpponent = Math.max(0, ...opponents.map((s) => s.length));
  const settings = gameState.game.ruleset?.settings as { hazardDamagePerTurn?: number } | undefined;
  const hazardDamage = settings?.hazardDamagePerTurn ?? 14;

  let best: { move: string; score: number } | undefined;
  for (const [name, dx, dy] of MOVES) {
    const target = { x: head.x + dx, y: head.y + dy };
    if (!grid.free(target)) continue; // parede, pescoço ou corpo: morte certa

    const eats = food.some((f) => same(f, target));
    const inHazard = hazards.some((h) => same(h, target));
    if (inHazard && !eats && me.health <= hazardDamage + 1) continue; // o hazard zera a vida

    let score = 0;

    for (const o of opponents) {
      if (distance(o.head, target) === 1) {
        if (o.length > me.length) score += H2H_BIGGER;
        else if (o.length === me.length) score += H2H_EQUAL;
        else score += H2H_SMALLER;
      }
    }

    let space = 0;
    grid.bfs(target, () => {
      space++;
      return false;
    });
    if (space < me.length) score += TRAP;
    // Espaço acima de 2x o corpo não faz diferença: aí quem decide é a comida.
    score += Math.min(space, 2 * me.length);

    if (inHazard) score += HAZARD;

    // Comida mais próxima que nenhum adversário maior/igual alcança antes.
    let foodDist: number | undefined;
    grid.bfs(target, (c, d) => {
      const found =
        food.some((f) => same(f, c)) &&
        !opponents.some((o) => o.length >= me.length && distance(o.head, c) <= d + 1);
      if (found) foodDist = d;
      return found;
    });
    if (foodDist !== undefined) {
      if (me.health - 1 - foodDist < HUNGER_MARGIN) {
        score += Math.max(0, 200 - 5 * foodDist); // fome: comida vira prioridade
      } else if (me.length <= biggestOpponent) {
        score += Math.max(0, 40 - 2 * foodDist); // crescer para ganhar os head-to-heads
      }
    }

    if (!best || score > best.score) best = { move: name, score };
  }

  if (!best) {
    console.log(`MOVE ${gameState.turn}: sem saída!`);
    return { move: "up" };
  }
  if (process.env.DEBUG === "true") {
    console.log(`MOVE ${gameState.turn}: ${best.move} (nota ${best.score})`);
  }
  return { move: best.move };
}
